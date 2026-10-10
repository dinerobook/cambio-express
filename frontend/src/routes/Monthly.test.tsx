import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Monthly from "./Monthly";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Monthly P&L at /monthly?year=Y&month=M.
//   - The URL month decides which report is requested; with none,
//     the page lands on the latest logged month.
//   - The picker moves between months (including old logged ones).
//   - A month with no row is an empty state, not a blank page.
//   - The store's own line names replace the shipped ones.
//   - Edit / Categories are offered only to someone who may use them.

const useMonthly = vi.fn();
const useLoggedMonths = vi.fn();

vi.mock("../api/monthly", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/monthly")>();
  return {
    ...real,
    useMonthly: (...a: unknown[]) => useMonthly(...a),
    useLoggedMonths: (...a: unknown[]) => useLoggedMonths(...a),
  };
});

const report = {
  id: 1, store_id: 1, year: 2020, month: 3,
  taxable_sales: 1000, non_taxable: 0, boost_mobile: 55.5,
  other_expense_1: 42, notes: "Audit pending",
  total_income: 1055.5, total_expenses: 42, net_profit: 1013.5,
  cash_carry_forward: 200, bank_locked: [],
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderPage(url = "/monthly?year=2020&month=3") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Monthly />
      <Where />
    </MemoryRouter>,
  );
}

function ok(data: unknown) {
  return { data, isLoading: false, isError: false, refetch: vi.fn() };
}

describe("Monthly P&L", () => {
  beforeEach(() => {
    useMonthly.mockReset();
    useLoggedMonths.mockReset();
    useMonthly.mockReturnValue(ok({ report, labels: {} }));
    useLoggedMonths.mockReturnValue(ok({ months: [{ year: 2020, month: 3 }] }));
  });

  it("requests the month named in the URL and shows its totals", () => {
    renderPage();
    expect(useMonthly).toHaveBeenLastCalledWith(2020, 3);
    expect(screen.getByText("Total income").parentElement).toHaveTextContent("$1,055.50");
    expect(screen.getByText("Total expenses").parentElement).toHaveTextContent("$42.00");
    expect(screen.getByText("Net profit").parentElement).toHaveTextContent("$1,013.50");
    expect(screen.getByText("Boost Mobile").parentElement).toHaveTextContent("$55.50");
    expect(screen.getByText("Audit pending")).toBeInTheDocument();
  });

  it("shows the store's own names for its lines", () => {
    useMonthly.mockReturnValue(ok({
      report, labels: { other_expense_1: "Bank Fee", boost_mobile: "Top-ups" },
    }));
    renderPage();
    expect(screen.getByText("Bank Fee").parentElement).toHaveTextContent("$42.00");
    expect(screen.getByText("Top-ups")).toBeInTheDocument();
    expect(screen.queryByText("Other expense 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Boost Mobile")).not.toBeInTheDocument();
  });

  it("shows an empty state for a month with no P&L", () => {
    useMonthly.mockReturnValue(ok({ report: null, labels: {} }));
    renderPage();
    expect(screen.getByText("No P&L logged for Mar 2020 yet.")).toBeInTheDocument();
    expect(screen.queryByText("Total income")).not.toBeInTheDocument();
  });

  it("lands on the latest logged month when the URL names none", () => {
    useLoggedMonths.mockReturnValue(ok({
      months: [{ year: 2019, month: 11 }, { year: 2018, month: 2 }],
    }));
    renderPage("/monthly");
    expect(screen.getByTestId("where")).toHaveTextContent("year=2019");
    expect(screen.getByTestId("where")).toHaveTextContent("month=11");
  });

  it("moves to another month from the picker, even an old one", async () => {
    useLoggedMonths.mockReturnValue(ok({
      months: [{ year: 2020, month: 3 }, { year: 2018, month: 2 }],
    }));
    renderPage();
    await userEvent.selectOptions(screen.getByRole("combobox"), "2018-2");
    expect(screen.getByTestId("where")).toHaveTextContent("year=2018");
    expect(screen.getByTestId("where")).toHaveTextContent("month=2");
    expect(useMonthly).toHaveBeenLastCalledWith(2018, 2);
  });

  it("shows a retryable error when the report fails to load", async () => {
    const refetch = vi.fn();
    useMonthly.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(500, "P&L unavailable", null), refetch,
    });
    renderPage();
    expect(screen.getByText("P&L unavailable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("offers Edit and Categories to someone who may update the P&L", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Edit" }))
      .toHaveAttribute("href", "/monthly/edit?year=2020&month=3");
    expect(screen.getByRole("link", { name: "Categories" }))
      .toHaveAttribute("href", "/monthly/categories");
  });

  it("hides Edit and Categories from a read-only viewer", () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee", permissions: ["monthly.read"],
    });
    renderPage();
    expect(screen.getByText("Total income")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Categories" })).not.toBeInTheDocument();
  });
});
