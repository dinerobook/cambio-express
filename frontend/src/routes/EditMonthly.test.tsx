import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditMonthly from "./EditMonthly";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Monthly P&L editor. Pinned here (api/Modules/Monthly/INVARIANTS.md):
//   - Only operator-editable columns go to the server. Derived ones
//     (cash_purchases, cash_expenses, check_cashing_fees, payroll,
//     return_check_gl, totals) are the 422 trap: they must NEVER be
//     in the PUT body.
//   - A bank-fed column is read-only and is not sent either.
//   - The store's own line names are what the operator reads.
//   - A refused save shows the server's reason and stays on the page.

const updateMonthly = vi.fn();
const useMonthly = vi.fn();

vi.mock("../api/monthly", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/monthly")>();
  return {
    ...real,
    updateMonthly: (...a: unknown[]) => updateMonthly(...a),
    useMonthly: (...a: unknown[]) => useMonthly(...a),
  };
});

// A stable object: the form re-hydrates whenever `data` changes
// identity, which would wipe the operator's typing.
const detail = {
  report: {
    id: 1, store_id: 1, year: 2026, month: 9,
    taxable_sales: 1000, non_taxable: 0, boost_mobile: 25,
    other_expense_1: 7, bank_charges_total: 18.5,
    // derived columns the server owns
    cash_purchases: 300, cash_expenses: 120, check_cashing_fees: 60,
    cash_payroll: 500, return_check_gl: -5,
    total_income: 1085, total_expenses: 950, net_profit: 135,
    notes: "Sept notes",
    bank_locked: ["bank_charges_total"],
  },
  labels: { other_expense_1: "Bank Fee" },
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderPage(url = "/monthly/edit?year=2026&month=9") {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[url]}>
        <EditMonthly />
        <Where />
      </MemoryRouter>
    </ToastProvider>,
  );
}

const DERIVED = [
  "cash_purchases", "check_purchases", "cash_expenses", "check_expenses",
  "cash_payroll", "check_payroll", "check_cashing_fees", "return_check_gl",
  "total_income", "total_expenses", "net_profit", "bank_locked",
  "id", "store_id", "year", "month",
];

describe("EditMonthly", () => {
  beforeEach(() => {
    updateMonthly.mockReset();
    updateMonthly.mockResolvedValue(detail);
    useMonthly.mockReset();
    useMonthly.mockReturnValue({
      data: detail, isLoading: false, isFetching: false, isError: false,
    });
  });

  it("saves edited fields as numbers and never sends derived columns", async () => {
    renderPage();
    const sales = screen.getByLabelText(/^\$?\s*Taxable sales/);
    await userEvent.clear(sales);
    await userEvent.type(sales, "1234.50");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateMonthly).toHaveBeenCalledTimes(1));
    const [year, month, body] = updateMonthly.mock.calls[0];
    expect([year, month]).toEqual([2026, 9]);
    expect(body.taxable_sales).toBe(1234.5);
    expect(body.boost_mobile).toBe(25);
    expect(body.other_expense_1).toBe(7);
    expect(body.notes).toBe("Sept notes");
    for (const key of DERIVED) expect(body).not.toHaveProperty(key);
    for (const v of Object.values(body)) {
      expect(["number", "string"]).toContain(typeof v);
    }
    // Saved -> toast, then back to the report.
    expect(await screen.findByText("Monthly P&L saved.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/monthly?year=2026&month=9"));
  });

  it("sends notes edits", async () => {
    renderPage();
    const notes = screen.getByDisplayValue("Sept notes");
    await userEvent.clear(notes);
    await userEvent.type(notes, "Reconciled");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateMonthly).toHaveBeenCalled());
    expect(updateMonthly.mock.calls[0][2].notes).toBe("Reconciled");
  });

  it("shows a bank-fed column read-only and does not send it", async () => {
    renderPage();
    const bank = screen.getByLabelText(/^\$?\s*Bank charges/);
    expect(bank).toHaveValue("18.5");
    expect(bank).toHaveAttribute("readonly");
    expect(bank).toBeDisabled();
    expect(screen.getByText(/From bank/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateMonthly).toHaveBeenCalled());
    expect(updateMonthly.mock.calls[0][2]).not.toHaveProperty("bank_charges_total");
  });

  it("leaves a bank-charges column editable when the bank does not feed it", async () => {
    useMonthly.mockReturnValue({
      data: { ...detail, report: { ...detail.report, bank_locked: [] } },
      isLoading: false, isFetching: false, isError: false,
    });
    renderPage();
    const bank = screen.getByLabelText(/^\$?\s*Bank charges/);
    expect(bank).not.toBeDisabled();
    await userEvent.clear(bank);
    await userEvent.type(bank, "20");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateMonthly).toHaveBeenCalled());
    expect(updateMonthly.mock.calls[0][2].bank_charges_total).toBe(20);
  });

  it("labels lines with the store's own names", () => {
    renderPage();
    expect(screen.getByLabelText(/^\$?\s*Bank Fee/)).toHaveValue("7");
    expect(screen.queryByLabelText(/Other expense 1/)).not.toBeInTheDocument();
    // An unrenamed line keeps the shipped name.
    expect(screen.getByLabelText(/^\$?\s*Other expense 2/)).toBeInTheDocument();
  });

  it("starts a month with no row empty", async () => {
    useMonthly.mockReturnValue({
      data: { report: null, labels: {} },
      isLoading: false, isFetching: false, isError: false,
    });
    renderPage();
    expect(screen.getByLabelText(/^\$?\s*Taxable sales/)).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateMonthly).toHaveBeenCalled());
    expect(updateMonthly.mock.calls[0][2].taxable_sales).toBe(0);
  });

  it("shows the server's reason when a save is refused", async () => {
    updateMonthly.mockRejectedValue(new ApiError(422, "Month is closed.", null));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Month is closed.");
    expect(screen.getByTestId("where")).toHaveTextContent("/monthly/edit");
  });

  it("asks before discarding edits on Cancel", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText(/^\$?\s*Taxable sales/), "5");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/monthly/edit");
  });

  it("asks for a month when the URL has none", () => {
    renderPage("/monthly/edit");
    expect(screen.getByText(/Missing year or month/)).toBeInTheDocument();
    // ...and no request for month 0 of year 0 goes out.
    expect(useMonthly).toHaveBeenCalledWith(undefined, undefined);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("offers no form without a store", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "superadmin", store_id: null });
    renderPage();
    expect(screen.getByText(/Sign in as a store admin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});
