import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Monthly from "./Monthly";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// The Monthly P&L's Transactions tab (Monthly INVARIANTS
// "Transactions"):
//   - shown only for a store with `pl_transactions` on, to someone
//     who may read bank rows;
//   - a statement line opens its rows;
//   - views with counts, the completeness line, filters in the URL;
//   - a bank row is categorized in place; the double-count guard
//     offers to link the daily book entry or to say it is different
//     money; "Make a rule" opens the rule popup.

const useMonthly = vi.fn();
const useLoggedMonths = vi.fn();
const usePLTransactions = vi.fn();
const categorizeTransaction = vi.fn();
const acceptPLSuggestions = vi.fn();
const matchTransaction = vi.fn();

vi.mock("../api/monthly", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/monthly")>();
  return {
    ...real,
    useMonthly: (...a: unknown[]) => useMonthly(...a),
    useLoggedMonths: (...a: unknown[]) => useLoggedMonths(...a),
    usePLTransactions: (...a: unknown[]) => usePLTransactions(...a),
    acceptPLSuggestions: (...a: unknown[]) => acceptPLSuggestions(...a),
  };
});

vi.mock("../api/bankSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/bankSync")>();
  return {
    ...real,
    useBankAccounts: () => ({ data: { rows: [] }, isLoading: false, isError: false }),
    useBankCategories: () => ({
      data: {
        groups: [{
          label: "Monthly P&L",
          options: [
            { slug: "pl_accounting_charges", label: "Accounting charges" },
            { slug: "pl_credit_card_fees", label: "Credit card fees" },
          ],
        }],
      },
      isLoading: false, isError: false,
    }),
    categorizeTransaction: (...a: unknown[]) => categorizeTransaction(...a),
    matchTransaction: (...a: unknown[]) => matchTransaction(...a),
  };
});

const report = {
  id: 1, store_id: 1, year: 2026, month: 11,
  taxable_sales: 900, credit_card_fees: 45, total_income: 900,
  total_expenses: 45, net_profit: 855, cash_carry_forward: 0,
  bank_locked: ["credit_card_fees"], daily_fed: ["taxable_sales"],
  days_entered: 12, saved: false, money_order_count: 0, money_order_charges: 0,
  notes: "",
};

function row(over: Record<string, unknown>) {
  return {
    key: "x", source: "bank", day: "2026-11-07", description: "", amount: 0,
    line: null, bucket: null, status: "to_review", counted: false,
    bank_amount: null, txn_id: null, category_slug: "", rule_id: null,
    item_kind: "", book: "", account_label: "", report_date_override: null,
    bank_date: null, booked_on: null, suggested_slug: "", suggested_source: "",
    ...over,
  };
}

const ROWS = [
  row({
    key: "bank:7", description: "ZELLE PAYMENT", amount: 9.99, txn_id: 7,
    bank_amount: -9.99, bank_date: "2026-11-10", day: "2026-11-10",
    account_label: "Checking ••0230",
  }),
  row({
    key: "bank:8", description: "SQUARE FEES", amount: 45, txn_id: 8,
    bank_amount: -45, line: "credit_card_fees", bucket: "expense",
    status: "rule", counted: true, category_slug: "pl_credit_card_fees",
  }),
  row({
    key: "day:msb:2026-11-02:taxable_sales", source: "day", book: "msb",
    day: "2026-11-02", amount: 900, line: "taxable_sales", bucket: "income",
    status: "daily", counted: true,
  }),
];

function listOf(
  rows = ROWS, counts = { review: 1, in_pl: 2, not_pl: 0, all: 3 }, suggested = 0,
) {
  return {
    data: {
      rows, total: rows.length, page: 1, total_pages: 1, counts,
      total_income: 900, total_expenses: 45, net_profit: 855,
      days_entered: 12, days_in_month: 30, suggested,
    },
    isLoading: false, isError: false, refetch: vi.fn(),
  };
}

function ok(data: unknown) {
  return { data, isLoading: false, isError: false, refetch: vi.fn() };
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderPage(url = "/monthly?year=2026&month=11&tab=transactions") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          <Monthly />
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function withPermissions(drop: string[] = []) {
  setCurrentIdentity({
    ...TEST_ADMIN,
    permissions: TEST_ADMIN.permissions.filter((p) => !drop.includes(p)),
  });
}

const where = () => screen.getByTestId("where").textContent ?? "";

beforeEach(() => {
  for (const fn of [
    useMonthly, useLoggedMonths, usePLTransactions, categorizeTransaction,
    matchTransaction, acceptPLSuggestions,
  ]) fn.mockReset();
  setCurrentIdentity(TEST_ADMIN);
  useMonthly.mockReturnValue(ok({ report, labels: {}, transactions_enabled: true }));
  useLoggedMonths.mockReturnValue(ok({ months: [{ year: 2026, month: 11 }] }));
  usePLTransactions.mockReturnValue(listOf());
});

describe("Monthly P&L transactions tab", () => {
  it("is not offered when the store does not have it", () => {
    useMonthly.mockReturnValue(ok({ report, labels: {}, transactions_enabled: false }));
    renderPage();
    expect(screen.queryByRole("tab", { name: "Transactions" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("pl-completeness")).not.toBeInTheDocument();
    // The statement shows instead, and its lines are plain text.
    expect(screen.getByText("Taxable sales").closest("a")).toBeNull();
  });

  it("is not offered to someone who cannot read bank rows", () => {
    withPermissions(["bank_sync.read"]);
    renderPage();
    expect(screen.queryByRole("tab", { name: "Transactions" })).not.toBeInTheDocument();
  });

  it("lists the month with views, counts and the completeness line", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: "Transactions" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "To review (1)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "In P&L (2)" })).toBeInTheDocument();
    expect(screen.getByTestId("pl-completeness")).toHaveTextContent(
      "1 bank transaction to review →",
    );
    expect(screen.getByTestId("pl-completeness")).toHaveTextContent(
      "Daily book: 12 of 30 days entered",
    );
    const sales = screen.getByText("MSB daily book, day total").closest("tr")!;
    expect(sales).toHaveTextContent("Taxable sales");
    expect(sales).toHaveTextContent("$900.00");
    expect(within(sales).getByText("Daily book")).toBeInTheDocument();
    expect(screen.getByText("Checking ••0230")).toBeInTheDocument();
  });

  it("a statement line opens its rows", async () => {
    renderPage("/monthly?year=2026&month=11");
    await userEvent.click(screen.getByRole("link", { name: "Taxable sales" }));
    expect(where()).toContain("tab=transactions");
    expect(where()).toContain("line=taxable_sales");
    await waitFor(() => expect(usePLTransactions).toHaveBeenLastCalledWith(
      2026, 11, expect.objectContaining({ line: "taxable_sales", view: "all" }), true,
    ));
  });

  it("switching view keeps the month and asks for that view", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /1 bank transaction to review/ }));
    expect(where()).toContain("view=review");
    expect(where()).toContain("year=2026");
    expect(usePLTransactions).toHaveBeenLastCalledWith(
      2026, 11, expect.objectContaining({ view: "review" }), true,
    );
  });

  it("categorizes a bank row in place", async () => {
    categorizeTransaction.mockResolvedValue({ transaction: { booked_on: "" } });
    renderPage();
    const zelle = screen.getByText("ZELLE PAYMENT").closest("tr")!;
    await userEvent.selectOptions(
      within(zelle).getByRole("combobox", { name: "Category" }),
      "pl_accounting_charges",
    );
    expect(categorizeTransaction).toHaveBeenCalledWith(7, {
      target_kind: "pl_accounting_charges", post_to_daily: true,
    });
  });

  it("asks before counting a daily book check twice, and links it", async () => {
    categorizeTransaction.mockRejectedValueOnce(new ApiError(409, "conflict", {
      detail: {
        code: "maybe_in_daily_book", message: "x",
        candidates: [{
          id: 55, report_date: "2026-11-03", kind: "check_expense",
          kind_label: "Check expense", amount: 9.99, note: "",
        }],
      },
    }));
    matchTransaction.mockResolvedValue({ transaction: {} });
    renderPage();
    const zelle = screen.getByText("ZELLE PAYMENT").closest("tr")!;
    await userEvent.selectOptions(
      within(zelle).getByRole("combobox", { name: "Category" }),
      "pl_accounting_charges",
    );
    const alert = await within(zelle).findByRole("alert");
    expect(alert).toHaveTextContent("This may already be on the daily book");
    await userEvent.click(within(alert).getByRole("button", { name: /Check expense \$9\.99/ }));
    expect(matchTransaction).toHaveBeenCalledWith(7, [55]);
  });

  it("different money sends it again with force", async () => {
    categorizeTransaction
      .mockRejectedValueOnce(new ApiError(409, "conflict", {
        detail: {
          code: "maybe_in_daily_book", message: "x",
          candidates: [{
            id: 55, report_date: "2026-11-03", kind: "check_expense",
            kind_label: "Check expense", amount: 9.99, note: "",
          }],
        },
      }))
      .mockResolvedValueOnce({ transaction: { booked_on: "" } });
    renderPage();
    const zelle = screen.getByText("ZELLE PAYMENT").closest("tr")!;
    await userEvent.selectOptions(
      within(zelle).getByRole("combobox", { name: "Category" }),
      "pl_accounting_charges",
    );
    await userEvent.click(await within(zelle).findByRole("button", { name: "No, different money" }));
    expect(categorizeTransaction).toHaveBeenLastCalledWith(7, {
      target_kind: "pl_accounting_charges", post_to_daily: true, force: true,
    });
  });

  it("shows the category as text to someone who cannot categorize", () => {
    withPermissions(["bank_sync.update"]);
    renderPage();
    const fees = screen.getByText("SQUARE FEES").closest("tr")!;
    expect(within(fees).queryByRole("combobox")).not.toBeInTheDocument();
    expect(fees).toHaveTextContent("Credit card fees");
  });

  it("makes a rule from a row", async () => {
    renderPage();
    const zelle = screen.getByText("ZELLE PAYMENT").closest("tr")!;
    await userEvent.click(within(zelle).getByRole("button", { name: "Make a rule" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Make a rule from this transaction");
  });

  it("offers a suggestion on a row to review and accepts it", async () => {
    usePLTransactions.mockReturnValue(listOf([
      { ...ROWS[0], suggested_slug: "pl_accounting_charges", suggested_source: "history" },
      ...ROWS.slice(1),
    ], undefined, 1));
    acceptPLSuggestions.mockResolvedValue({ accepted: 1, locked: 0, maybe_in_daily_book: 0 });
    renderPage();
    const zelle = screen.getByText("ZELLE PAYMENT").closest("tr")!;
    expect(zelle).toHaveTextContent("Suggested: Accounting charges");
    await userEvent.click(within(zelle).getByRole("button", { name: "Accept" }));
    expect(acceptPLSuggestions).toHaveBeenCalledWith(2026, 11, [7]);
    expect(await screen.findByText("1 transaction categorized.")).toBeInTheDocument();
  });

  it("accepts every suggestion in one click and says what it left", async () => {
    usePLTransactions.mockReturnValue(listOf(ROWS, undefined, 3));
    acceptPLSuggestions.mockResolvedValue({ accepted: 2, locked: 1, maybe_in_daily_book: 0 });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Accept all 3 suggestions" }));
    expect(acceptPLSuggestions).toHaveBeenCalledWith(2026, 11, []);
    expect(await screen.findByText(/2 transactions categorized\. 1 left to review/)).toBeInTheDocument();
  });

  it("offers no Accept to someone who cannot categorize", () => {
    withPermissions(["bank_sync.update"]);
    usePLTransactions.mockReturnValue(listOf([
      { ...ROWS[0], suggested_slug: "pl_accounting_charges", suggested_source: "template" },
    ], undefined, 1));
    renderPage();
    expect(screen.queryByRole("button", { name: /Accept/ })).not.toBeInTheDocument();
  });

  it("shows a retry when the list fails", async () => {
    const refetch = vi.fn();
    usePLTransactions.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(500, "boom", null), refetch,
    });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("reads in Spanish", () => {
    setLanguage("es");
    try {
      renderPage();
      expect(screen.getByRole("tab", { name: "Transacciones" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Por revisar (1)" })).toBeInTheDocument();
      expect(screen.getByTestId("pl-completeness")).toHaveTextContent(
        "Libro diario: 12 de 30 días ingresados",
      );
      expect(englishLeftovers(document.body, ["plTx.", "bankCat.", "bankTxn."])).toEqual([]);
    } finally {
      setLanguage("en");
    }
  });
});
