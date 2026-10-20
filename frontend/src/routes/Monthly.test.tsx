import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Monthly from "./Monthly";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Monthly P&L at /monthly?year=Y&month=M.
//   - The URL month decides which report is requested; with none,
//     the page lands on the latest month the server knows of.
//   - The picker and the ← / → stepper move between months.
//   - The P&L is live from the daily books: it says how many days it
//     was built from, each line says where its figure comes from, and
//     lines at $0 are left out.
//   - Net profit shows its margin and the change on last month.
//   - A month with nothing in it points at the daily book.
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
  check_cashing_fees: 0, money_order_fees: 0,
  cash_purchases: 0, other_expense_1: 42, notes: "Audit pending",
  total_income: 1055.5, total_expenses: 42, net_profit: 1013.5,
  cash_carry_forward: 200, bank_locked: [], daily_fed: ["taxable_sales"],
  days_entered: 12, saved: true, money_order_count: 0, money_order_charges: 0,
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

/** The KPI tile whose label is `label`. */
const kpi = (label: string) =>
  screen.getAllByText(label).find((el) => el.closest(".ds-kpi-card"))!
    .closest(".ds-kpi-card") as HTMLElement;

/** The statement row for one line. */
const lineRow = (name: string) => screen.getByText(name).closest("tr")!;

describe("Monthly P&L", () => {
  beforeEach(() => {
    useMonthly.mockReset();
    useLoggedMonths.mockReset();
    useMonthly.mockReturnValue(ok({ report, labels: {} }));
    useLoggedMonths.mockReturnValue(ok({ months: [{ year: 2020, month: 3 }] }));
  });

  it("requests the month named in the URL and shows its totals", () => {
    renderPage();
    expect(useMonthly).toHaveBeenCalledWith(2020, 3);
    expect(kpi("Total income")).toHaveTextContent("$1,055.50");
    expect(kpi("Total expenses")).toHaveTextContent("$42.00");
    expect(kpi("Net profit")).toHaveTextContent("$1,013.50");
    expect(kpi("Cash carry forward")).toHaveTextContent("$200.00");
    expect(lineRow("Boost Mobile")).toHaveTextContent("$55.50");
    expect(screen.getByText("Audit pending")).toBeInTheDocument();
  });

  it("says it is live and how many days it was built from", () => {
    renderPage();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText(/Built from 12 days entered in the daily books/))
      .toBeInTheDocument();
  });

  it("tells an unsaved month where the remaining lines go", () => {
    useMonthly.mockReturnValue(ok({
      report: { ...report, id: null, saved: false, days_entered: 1 }, labels: {},
    }));
    renderPage();
    expect(screen.getByText(/Built from 1 day entered/)).toBeInTheDocument();
    expect(screen.getByText(/added under Edit/)).toBeInTheDocument();
  });

  it("marks each line with where its figure comes from", () => {
    useMonthly.mockReturnValue(ok({
      report: {
        ...report, credit_card_fees: 30, return_check_gl: 12,
        bank_locked: ["credit_card_fees"],
      },
      labels: {},
    }));
    renderPage();
    expect(within(lineRow("Taxable sales")).getByText("Daily book")).toBeInTheDocument();
    expect(within(lineRow("Credit card fees")).getByText("Bank")).toBeInTheDocument();
    expect(within(lineRow("Returned check gain/loss")).getByText("Return checks"))
      .toBeInTheDocument();
    expect(within(lineRow("Boost Mobile")).getByText("Typed")).toBeInTheDocument();
  });

  it("leaves out lines at $0 and says how many", () => {
    renderPage();
    expect(screen.queryByText("Non-taxable")).not.toBeInTheDocument();
    expect(screen.queryByText("Cash purchases")).not.toBeInTheDocument();
    const footnotes = screen.getAllByText((_, el) =>
      el?.tagName === "P" && /lines? at \$0 not shown/.test(el.textContent ?? ""));
    expect(footnotes).toHaveLength(2);
  });

  it("shows money order fees net of the company charges", () => {
    useMonthly.mockReturnValue(ok({
      report: {
        ...report, money_order_fees: 30.4, money_order_count: 12,
        money_order_charges: 3.6, daily_fed: ["money_order_fees"],
      },
      labels: {},
    }));
    renderPage();
    const row = lineRow("Money order fees");
    expect(row).toHaveTextContent("$30.40");
    expect(row).toHaveTextContent("After $3.60 company charges on 12 money orders");
  });

  it("shows the profit margin and the change on last month", () => {
    useMonthly.mockImplementation((_y: number, m: number) => ok({
      report: m === 3 ? report : { ...report, month: 2, net_profit: 800, total_income: 900, total_expenses: 100 },
      labels: {},
    }));
    renderPage();
    expect(useMonthly).toHaveBeenCalledWith(2020, 2);
    const net = kpi("Net profit");
    expect(net).toHaveTextContent("96% of income");
    expect(net).toHaveTextContent("▲ $214 vs Feb");
  });

  it("shows the store's own names for its lines", () => {
    useMonthly.mockReturnValue(ok({
      report, labels: { other_expense_1: "Bank Fee", boost_mobile: "Top-ups" },
    }));
    renderPage();
    expect(lineRow("Bank Fee")).toHaveTextContent("$42.00");
    expect(screen.getByText("Top-ups")).toBeInTheDocument();
    expect(screen.queryByText("Other expense 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Boost Mobile")).not.toBeInTheDocument();
  });

  it("points a month with nothing in it at the daily book", () => {
    useMonthly.mockReturnValue(ok({ report: null, labels: {} }));
    renderPage();
    expect(screen.getByText("Nothing recorded for Mar 2020 yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the daily book" }))
      .toHaveAttribute("href", "/daily");
    expect(screen.queryByText("Total income")).not.toBeInTheDocument();
  });

  it("lands on the latest month the server knows of when the URL names none", () => {
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
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Month" }), "2018-2");
    expect(screen.getByTestId("where")).toHaveTextContent("year=2018");
    expect(screen.getByTestId("where")).toHaveTextContent("month=2");
    expect(useMonthly).toHaveBeenCalledWith(2018, 2);
  });

  it("steps a month back and forward with the arrows", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByTestId("where")).toHaveTextContent("year=2020&month=2");
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByTestId("where")).toHaveTextContent("year=2020&month=4");
  });

  it("shows a retryable error when the report fails to load", async () => {
    const refetch = vi.fn();
    useMonthly.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(500, "P&L unavailable", null), refetch,
    });
    renderPage();
    expect(screen.getByText("P&L unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing recorded/)).not.toBeInTheDocument();
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
    expect(kpi("Total income")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Categories" })).not.toBeInTheDocument();
    // No daily book access either: the empty state's link would hide too.
  });
});
