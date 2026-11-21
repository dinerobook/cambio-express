import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import TransactionItems from "./TransactionItems";
import { mockFetch } from "../test/fetchMock";
import { renderRoute } from "../test/renderRoute";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// Transactions → Items: every line sold (Modisoft's item report).
// The unit it sold at against its regular price, a below-regular
// line flagged, cost and margin when the price book has a cost, the
// department and Show filters reaching the API, and a row opening its
// ticket's receipt.

const line = (over: Record<string, unknown> = {}) => ({
  id: 1, transaction_id: 9, transaction_no: "5885", business_date: "2026-03-07",
  at: "2026-03-08T18:48:00", kind: "sale", register_id: "1",
  cashier_id: "91", cashier_name: "", status: "normal",
  pos_code: "810030510482", description: "ALANI WATERMELON WAVE",
  merchandise_code: "10", department_name: "Taxable",
  quantity: 2, amount: 5.5, unit_price: 2.75, regular_price: 3.79,
  below_regular: true, is_fuel: false, gallons: 0, cost: 3.2, margin_pct: 41.82,
  ...over,
});

const list = (over: Record<string, unknown> = {}) => ({
  rows: [line()], total: 260, page: 1, total_pages: 6,
  total_quantity: 447, total_gallons: 1234.5, total_amount: 1929.07,
  total_cost: 3.2, costed_amount: 5.5,
  departments: [{ code: "10", name: "Taxable" }, { code: "4", name: "Lotto (Sell)" }],
  ...over,
});

describe("Transactions — Items", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem("db.page_size.pos-items");
    setLanguage("en");
  });

  it("lists each line with what it sold at against its regular price", async () => {
    mockFetch({ "GET /api/v2/posimport/transaction-lines": { body: list() } });
    renderRoute(<TransactionItems />);
    const row = (await screen.findByText("ALANI WATERMELON WAVE")).closest("tr")!;
    expect(row).toHaveTextContent("810030510482");
    expect(row).toHaveTextContent("Taxable");
    expect(row).toHaveTextContent("$2.75");
    expect(row).toHaveTextContent("$3.79");
    expect(row).toHaveTextContent("below regular");
    expect(row).toHaveTextContent("41.8%");
    expect(screen.getByText("Showing 1–1 of 260")).toBeInTheDocument();
    expect(screen.getByText("plus 1,235 gal of fuel")).toBeInTheDocument();
    // The line's margin and the KPI's, over the lines with a cost:
    // ($5.50 − $3.20) / $5.50.
    expect(screen.getAllByText("41.8%")).toHaveLength(2);
    expect(screen.getByText("on $5.50 of items with a cost")).toBeInTheDocument();
  });

  it("says a line has no cost rather than inventing one", async () => {
    mockFetch({
      "GET /api/v2/posimport/transaction-lines": {
        body: list({
          rows: [line({ cost: null, margin_pct: null, below_regular: false })],
          total_cost: 0, costed_amount: 0,
        }),
      },
    });
    renderRoute(<TransactionItems />);
    const row = (await screen.findByText("ALANI WATERMELON WAVE")).closest("tr")!;
    expect(row).not.toHaveTextContent("below regular");
    expect(screen.getByText("Add costs in the price book to see it")).toBeInTheDocument();
  });

  it("sends the department, the Show filter and the sort", async () => {
    const calls = mockFetch({ "GET /api/v2/posimport/transaction-lines": { body: list() } });
    const user = userEvent.setup();
    renderRoute(<TransactionItems />);
    await screen.findByText("ALANI WATERMELON WAVE");
    expect(calls.at(-1)!.url.searchParams.get("sort")).toBe("time");
    await user.selectOptions(screen.getByLabelText("Department"), "Lotto (Sell)");
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("department")).toBe("4"));
    await user.selectOptions(screen.getByLabelText("Show"), "Voided");
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("show")).toBe("voided"));
    await user.click(screen.getByRole("button", { name: /Amount/ }));
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("sort")).toBe("amount"));
  });

  it("opens the line's ticket as a receipt beside the list", async () => {
    mockFetch({
      "GET /api/v2/posimport/transaction-lines": { body: list() },
      "GET /api/v2/posimport/transactions/9": {
        body: { transaction: {
          id: 9, business_date: "2026-03-07", source_file: "PJR-9.xml", kind: "sale",
          register_id: "1", cashier_id: "91", cashier_name: "", detail_type: "",
          till_id: "7", transaction_no: "5885", event_sequence_id: "1",
          started_at: null, ended_at: null, receipt_at: "2026-03-08T18:48:00",
          outside: false, training_mode: false, offline: false, suspended: false,
          gross: 7.58, net: 5.95, tax: 0.45, grand_total: 5.95, has_voided_line: false,
          superseded: false, superseded_by_id: null, linked_reason: "",
          linked_transaction_no: "", linked_id: null,
          lines: [{
            line_seq: 1, status: "normal", pos_code: "810030510482",
            description: "ALANI WATERMELON WAVE", entry_method: "scan",
            merchandise_code: "10", department_name: "Taxable", quantity: 2,
            amount: 5.5, actual_price: 5.5, regular_price: 3.79, is_fuel: false,
            fuel_grade_id: "", fuel_position: "", gallons: 0,
          }],
          tenders: [{ code: "creditCards", sub_code: "generic", amount: 5.95, is_change: false, status: "normal" }],
        } },
      },
    });
    const user = userEvent.setup();
    renderRoute(<TransactionItems />, { path: "/transactions/items" });
    await screen.findByText("ALANI WATERMELON WAVE");
    await user.click(screen.getByRole("button", { name: "Open ticket 5885" }));
    const receipt = await screen.findByRole("article", { name: "Receipt" });
    expect(within(receipt).getByText("Regular $3.79")).toBeInTheDocument();
    expect(within(receipt).getByText("Savings")).toBeInTheDocument();
    expect(within(receipt).getByText("$2.08")).toBeInTheDocument();
    expect(within(receipt).getByText("Credit card")).toBeInTheDocument();
  });

  it("links back to the receipts with the same range", async () => {
    mockFetch({ "GET /api/v2/posimport/transaction-lines": { body: list() } });
    renderRoute(<TransactionItems />, { path: "/transactions/items", at: "/transactions/items?start=2026-03-01&end=2026-03-07" });
    await screen.findByText("ALANI WATERMELON WAVE");
    expect(screen.getByRole("tab", { name: "Receipts" }))
      .toHaveAttribute("href", "/transactions?start=2026-03-01&end=2026-03-07");
  });

  it("reads in Spanish", async () => {
    setLanguage("es");
    mockFetch({ "GET /api/v2/posimport/transaction-lines": { body: list() } });
    renderRoute(<TransactionItems />);
    const row = (await screen.findByText("ALANI WATERMELON WAVE")).closest("tr")!;
    expect(row).toHaveTextContent("bajo el precio normal");
    expect(screen.getByRole("tab", { name: "Artículos" })).toBeInTheDocument();
    expect(screen.getByLabelText("Mostrar")).toHaveDisplayValue("Todo lo vendido");
    expect(englishLeftovers(document.body, ["posItems.", "posTx."])).toEqual([]);
  });
});
