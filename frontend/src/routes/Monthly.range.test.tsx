import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Monthly from "./Monthly";
import PeriodPLRedirect from "./PeriodPLRedirect";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// Any date range on the Monthly P&L (the Period P&L, merged in on
// 2026-11-27 — Monthly INVARIANTS "Any date range"):
//   - from/to that are not one whole month read GET /monthly/range,
//     read-only: no Edit, no Transactions, a note naming what a cut
//     month leaves out;
//   - from/to that are one whole month open that month's full page;
//   - old Period P&L links (store and owner) land here with their days.

const useMonthly = vi.fn();
const useLoggedMonths = vi.fn();
const useMonthlyRange = vi.fn();

vi.mock("../api/monthly", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/monthly")>();
  return {
    ...real,
    useMonthly: (...a: unknown[]) => useMonthly(...a),
    useLoggedMonths: (...a: unknown[]) => useLoggedMonths(...a),
    useMonthlyRange: (...a: unknown[]) => useMonthlyRange(...a),
  };
});

const report = {
  id: null, store_id: 1, year: 2026, month: 11,
  taxable_sales: 300, cash_expenses: 40, credit_card_fees: 45,
  total_income: 300, total_expenses: 85, net_profit: 215,
  cash_carry_forward: 0, bank_locked: ["credit_card_fees"],
  daily_fed: ["taxable_sales", "cash_expenses"], days_entered: 2,
  saved: false, money_order_count: 0, money_order_charges: 0, notes: "",
  custom_lines: [],
};

function ok(data: unknown) {
  return { data, isLoading: false, isError: false, refetch: vi.fn() };
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/monthly" element={<><Monthly /><Where /></>} />
        <Route path="/reports/period-pl" element={<PeriodPLRedirect />} />
        <Route path="/owner/reports/period-pl" element={<PeriodPLRedirect />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const fn of [useMonthly, useLoggedMonths, useMonthlyRange]) fn.mockReset();
  setCurrentIdentity(TEST_ADMIN);
  useMonthly.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useLoggedMonths.mockReturnValue(ok({ months: [] }));
  useMonthlyRange.mockReturnValue(ok({
    report, labels: {}, date_from: "2026-10-15", date_to: "2026-11-10",
    whole_months: 0,
    left_out: [
      { line: "money_order_rent", amount: 150, year: 2026, month: 11 },
    ],
  }));
});
afterEach(() => setLanguage("en"));

describe("Monthly P&L for any days", () => {
  it("reads the range, read-only, and says what it leaves out", () => {
    renderAt("/monthly?from=2026-10-15&to=2026-11-10");
    expect(useMonthlyRange).toHaveBeenLastCalledWith({ from: "2026-10-15", to: "2026-11-10" });
    expect(useMonthly).toHaveBeenLastCalledWith(undefined, undefined);
    expect(screen.getByRole("button", { name: /^Period:/ }))
      .toHaveTextContent("Oct 15, 2026 – Nov 10, 2026");
    expect(screen.getByText(/read only/)).toBeInTheDocument();
    expect(screen.getByText("Money order rent: $150.00 (Nov 2026)")).toBeInTheDocument();
    expect(screen.getByText("Taxable sales").closest("tr")).toHaveTextContent("$300.00");
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous month" })).not.toBeInTheDocument();
  });

  it("opens one whole month as that month's page", () => {
    renderAt("/monthly?from=2026-11-01&to=2026-11-30");
    expect(screen.getByTestId("where")).toHaveTextContent("/monthly?year=2026&month=11");
    expect(useMonthly).toHaveBeenCalledWith(2026, 11);
    expect(useMonthlyRange).toHaveBeenLastCalledWith(null);
  });

  it("ignores days that make no range", () => {
    renderAt("/monthly?from=2026-11-10&to=2026-11-01&year=2026&month=11");
    expect(useMonthlyRange).toHaveBeenLastCalledWith(null);
    expect(useMonthly).toHaveBeenCalledWith(2026, 11);
  });

  it("shows a retry when the range fails", () => {
    const refetch = vi.fn();
    useMonthlyRange.mockReturnValue({
      data: undefined, isLoading: false, isError: true, error: new Error("boom"), refetch,
    });
    renderAt("/monthly?from=2026-10-15&to=2026-11-10");
    expect(screen.getByRole("button", { name: /Try again|Retry/ })).toBeInTheDocument();
  });

  it("takes old Period P&L links, the store's and the owner's, with their days", () => {
    renderAt("/reports/period-pl?from=2026-10-15&to=2026-11-10");
    expect(screen.getByTestId("where")).toHaveTextContent("/monthly?from=2026-10-15&to=2026-11-10");
  });

  it("takes an owner's old link with no days to this month's page", () => {
    renderAt("/owner/reports/period-pl");
    expect(screen.getByTestId("where").textContent).toMatch(/^\/monthly\?year=\d{4}&month=\d+$/);
  });

  it("reads in Spanish", () => {
    setLanguage("es");
    renderAt("/monthly?from=2026-10-15&to=2026-11-10");
    expect(screen.getByText(/solo lectura/)).toBeInTheDocument();
    expect(screen.getByText(/No incluidas/)).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["pl.", "range."])).toEqual([]);
  });
});
