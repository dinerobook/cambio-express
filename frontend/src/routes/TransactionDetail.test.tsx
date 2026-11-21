import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import TransactionDetail from "./TransactionDetail";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// A ticket where the cashier voided a $500 item and then rang a
// $12 one. The void must be VISIBLE (that is the point of the
// page) and must not appear in any total (that is the trap).
let detailOverride: Record<string, unknown> = {};
const detailData = () => ({ transaction: { ...detail.transaction, ...detailOverride } });
const detail = {
  transaction: {
    id: 42,
    business_date: "2025-12-08",
    source_file: "PJR340251209133139277539.xml",
    kind: "sale",
    register_id: "1",
    cashier_id: "3",
    cashier_name: "",
    detail_type: "",
    till_id: "0318",
    transaction_no: "8946",
    event_sequence_id: "7",
    started_at: null,
    ended_at: null,
    receipt_at: null,
    outside: false,
    training_mode: false,
    offline: false,
    suspended: false,
    gross: 12,
    net: 12,
    tax: 0,
    grand_total: 12,
    has_voided_line: true,
    superseded: false,
    superseded_by_id: null,
    linked_reason: "",
    linked_transaction_no: "",
    linked_id: null,
    lines: [
      {
        line_seq: 1,
        status: "cancel",
        pos_code: "111111111111",
        description: "VOIDED PREMIUM ITEM",
        entry_method: "scan",
        merchandise_code: "10",
        department_name: "Grocery",
        quantity: 1,
        amount: 500,
        actual_price: 500,
        regular_price: 500,
        is_fuel: false,
        fuel_grade_id: "",
        fuel_position: "",
        gallons: 0,
      },
      {
        line_seq: 2,
        status: "normal",
        pos_code: "222222222222",
        description: "COFFEE LARGE",
        entry_method: "scan",
        merchandise_code: "10",
        department_name: "Grocery",
        quantity: 1,
        amount: 12,
        actual_price: 12,
        regular_price: 12,
        is_fuel: false,
        fuel_grade_id: "",
        fuel_position: "",
        gallons: 0,
      },
    ],
    tenders: [
      {
        code: "cash", sub_code: "generic", amount: 12,
        is_change: false, status: "normal",
      },
    ],
  },
};

vi.mock("../api/posimport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/posimport")>()),
  useTransaction: () => ({
    data: detailData(), isLoading: false, isError: false,
  }),
}));

function renderDetail() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={["/transactions/42"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/transactions/:id" element={<TransactionDetail />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("TransactionDetail", () => {
  it("shows the voided line rather than hiding it", () => {
    renderDetail();
    expect(screen.getByText("VOIDED PREMIUM ITEM")).toBeInTheDocument();
    // Struck out at the price it rang at, once.
    expect(screen.getAllByText("$500.00").length).toBe(1);
    expect(screen.getByText("Void")).toBeInTheDocument();
    expect(screen.getByText("Voided qty")).toBeInTheDocument();
  });

  it("names each line's scan code and department, and how it was paid", () => {
    renderDetail();
    expect(screen.getByText("222222222222")).toBeInTheDocument();
    expect(screen.getAllByText(/Grocery/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Cash")).toBeInTheDocument();
  });

  it("flags an item sold below its regular price", () => {
    detailOverride = {
      lines: [{
        ...detail.transaction.lines[1], actual_price: 10, amount: 10, regular_price: 12,
      }],
    };
    renderDetail();
    expect(screen.getByText("Regular $12.00")).toBeInTheDocument();
    detailOverride = {};
  });

  it("shows a cashier by name and a drawer opened with no sale", () => {
    detailOverride = {
      kind: "other", detail_type: "NoSale", cashier_name: "Noel",
      lines: [], tenders: [], has_voided_line: false, grand_total: 0,
    };
    renderDetail();
    expect(screen.getAllByText("No sale").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Noel (#3)").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Subtotal")).not.toBeInTheDocument();
    detailOverride = {};
  });

  it("says a whole voided ticket is not counted", () => {
    detailOverride = { kind: "void", has_voided_line: false };
    renderDetail();
    expect(screen.getByText(/The whole ticket was voided/)).toBeInTheDocument();
    detailOverride = {};
  });

  it("keeps the voided amount out of every total", () => {
    renderDetail();
    // Items subtotal and ticket total are both $12 — the $500 void
    // contributes to neither. If a regression summed cancelled
    // lines this would read $512.
    expect(screen.getAllByText("$12.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("$512.00")).not.toBeInTheDocument();
  });

  it("says plainly that a void is excluded", () => {
    renderDetail();
    expect(
      screen.getByText(/One item was voided on this ticket/),
    ).toBeInTheDocument();
  });

  it("shows the register provenance", () => {
    renderDetail();
    expect(screen.getByText("Till")).toBeInTheDocument();
    expect(screen.getByText("0318")).toBeInTheDocument();
    expect(
      screen.getByText("PJR340251209133139277539.xml"),
    ).toBeInTheDocument();
  });

  it("reads in Spanish, kind and flags included", () => {
    detailOverride = { kind: "refund", outside: true };
    setLanguage("es");
    renderDetail();
    expect(screen.getByRole("heading", { name: "Ticket 8946" })).toBeInTheDocument();
    // The pill in the header and the stamp on the receipt.
    expect(screen.getAllByText("devolución")).toHaveLength(2);
    expect(screen.getByText("pago en la bomba")).toBeInTheDocument();
    expect(screen.getByText(/Se anuló un artículo en este ticket/)).toBeInTheDocument();
    expect(screen.getByText("Efectivo")).toBeInTheDocument();
    expect(screen.getByText("Cant. vendida")).toBeInTheDocument();
    expect(screen.getByText("Anulado")).toBeInTheDocument();
    expect(screen.getByText("Cajón")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["posTx."])).toEqual([]);
    detailOverride = {};
  });

  it("says a superseded prepay deposit is not counted", () => {
    detailOverride = { superseded: true, superseded_by_id: 43 };
    renderDetail();
    expect(screen.getByText("superseded")).toBeInTheDocument();
    expect(screen.getByText(/Part of a fuel prepay/)).toBeInTheDocument();
    expect(screen.getByText(/not counted in any total/)).toBeInTheDocument();
    detailOverride = {};
  });

  it("names the deposit a prepay completion restates", () => {
    detailOverride = {
      linked_reason: "fuelPrepay", linked_transaction_no: "1475", linked_id: 41,
    };
    renderDetail();
    expect(screen.getByText(/Completes the fuel prepay rung on ticket/)).toBeInTheDocument();
    expect(screen.getByText("1475")).toBeInTheDocument();
    expect(screen.queryByText("superseded")).not.toBeInTheDocument();
    detailOverride = {};
  });

  it("does not call a void completion the ticket that counts", () => {
    detailOverride = {
      kind: "void", linked_reason: "fuelPrepay", linked_transaction_no: "1475", linked_id: 41,
    };
    renderDetail();
    expect(screen.queryByText(/Completes the fuel prepay/)).not.toBeInTheDocument();
    detailOverride = {};
  });

  it("reads the prepay notes in Spanish", () => {
    detailOverride = { superseded: true, superseded_by_id: 43 };
    setLanguage("es");
    renderDetail();
    expect(screen.getByText("reemplazado")).toBeInTheDocument();
    expect(screen.getByText(/Parte de un prepago de gasolina/)).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["posTx."])).toEqual([]);
    setLanguage("en");
    detailOverride = {};
  });

  it("shows a ticket kind it does not know as sent", () => {
    detailOverride = { kind: "layaway" };
    renderDetail();
    expect(screen.getAllByText("layaway").length).toBeGreaterThanOrEqual(1);
    detailOverride = {};
  });
});
