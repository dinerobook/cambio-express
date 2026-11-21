import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import Transactions from "./Transactions";
import { callsTo, mockFetch } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// Register tickets as receipts: a tab per kind of ticket with its
// count, the shared table, and the chosen ticket's receipt beside the
// list (its own page on a narrow window). A void is flagged, a no-sale
// is named, a cashier shows by the name the store gave the number.

const ticket = {
  id: 9, transaction_no: "T-1001", business_date: "2026-10-03",
  receipt_at: null, started_at: null, detail_type: "",
  register_id: "R1", cashier_id: "91", cashier_name: "", item_count: 3,
  tax: 0.84, grand_total: 12.34, gross: 11.5, kind: "sale",
  has_voided_line: true, training_mode: false, offline: false, suspended: false,
  superseded: false,
};

const counts = { all: 80, sale: 70, refund: 4, void: 2, voided_items: 3, no_sale: 5 };

const list = (over: Record<string, unknown> = {}) => ({
  rows: [ticket], total: 80, page: 1, total_pages: 2,
  total_grand: 999.5, voided_count: 1, kind_counts: counts, ...over,
});

const detail = {
  transaction: {
    id: 9, business_date: "2026-10-03", source_file: "PJR-9.xml", kind: "sale",
    register_id: "R1", cashier_id: "91", cashier_name: "Noel", detail_type: "",
    till_id: "7", transaction_no: "T-1001", event_sequence_id: "1",
    started_at: "2026-10-03T19:02:00", ended_at: "2026-10-03T19:02:30",
    receipt_at: "2026-10-03T19:02:30", outside: false, training_mode: false,
    offline: false, suspended: false, gross: 11.5, net: 12.34, tax: 0.84,
    grand_total: 12.34, has_voided_line: false, superseded: false,
    superseded_by_id: null, linked_reason: "", linked_transaction_no: "", linked_id: null,
    lines: [{
      line_seq: 1, status: "normal", pos_code: "012345678905", description: "COFFEE LARGE",
      entry_method: "scan", merchandise_code: "10", department_name: "Hot drinks",
      quantity: 1, amount: 11.5, actual_price: 11.5, regular_price: 11.5,
      is_fuel: false, fuel_grade_id: "", fuel_position: "", gallons: 0,
    }],
    tenders: [{ code: "cash", sub_code: "generic", amount: 12.34, is_change: false, status: "normal" }],
  },
};

function narrowWindow() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {},
  }));
}

describe("POS transactions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem("db.page_size.pos-transactions");
    setLanguage("en");
    signInAs();
  });

  it("lists tickets with the void flagged and money right-aligned", async () => {
    mockFetch({ "GET /api/v2/posimport/transactions": { body: list() } });
    renderRoute(<Transactions />);
    const row = (await screen.findByText("T-1001")).closest("tr")!;
    expect(row).toHaveTextContent("voided item");
    expect(row).toHaveTextContent("#91");
    expect(screen.getByText("$12.34").closest("td")).toHaveStyle({ textAlign: "right" });
    expect(screen.getByText("Showing 1–1 of 80")).toBeInTheDocument();
  });

  it("shows a cashier by the name the store gave the number", async () => {
    mockFetch({
      "GET /api/v2/posimport/transactions": {
        body: list({ rows: [{ ...ticket, cashier_name: "Tania Cerrato" }] }),
      },
    });
    renderRoute(<Transactions />);
    const row = (await screen.findByText("T-1001")).closest("tr")!;
    expect(row).toHaveTextContent("Tania Cerrato (#91)");
  });

  it("counts every tab and sends the chosen tab's filter", async () => {
    const calls = mockFetch({ "GET /api/v2/posimport/transactions": { body: list() } });
    const user = userEvent.setup();
    renderRoute(<Transactions />);
    await screen.findByText("T-1001");
    for (const label of [
      "All (80)", "Sales (70)", "Refunds (4)", "Voided tickets (2)",
      "Voided items (3)", "No sales (5)",
    ]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("tab", { name: "All (80)" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "No sales (5)" }));
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("kind")).toBe("no_sale"));
    expect(calls.at(-1)!.url.searchParams.get("voided_only")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Voided items (3)" }));
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("voided_only")).toBe("true"));
    expect(calls.at(-1)!.url.searchParams.get("kind")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Refunds (4)" }));
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("kind")).toBe("refund"));
  });

  it("names a drawer opened with no sale", async () => {
    mockFetch({
      "GET /api/v2/posimport/transactions": {
        body: list({ rows: [{
          ...ticket, kind: "other", detail_type: "NoSale", has_voided_line: false,
          item_count: 0, grand_total: 0, started_at: "2026-10-03T19:00:00",
        }] }),
      },
    });
    renderRoute(<Transactions />);
    const row = (await screen.findByText("T-1001")).closest("tr")!;
    expect(row).toHaveTextContent("No sale");
    expect(row).not.toHaveTextContent("other");
    // No receipt is printed: the start time stands in for it.
    expect(row).not.toHaveTextContent("2026-10-03");
  });

  it("flags a fuel prepay deposit its completion superseded", async () => {
    mockFetch({
      "GET /api/v2/posimport/transactions": {
        body: list({ rows: [{ ...ticket, has_voided_line: false, superseded: true }] }),
      },
    });
    renderRoute(<Transactions />);
    const row = (await screen.findByText("T-1001")).closest("tr")!;
    expect(row).toHaveTextContent("superseded");
    expect(row).not.toHaveTextContent("voided item");
  });

  it("opens a ticket's receipt beside the list, by keyboard", async () => {
    mockFetch({
      "GET /api/v2/posimport/transactions": { body: list() },
      "GET /api/v2/posimport/transactions/9": { body: detail },
    });
    const user = userEvent.setup();
    renderRoute(<Transactions />, { path: "/transactions" });
    await screen.findByText("T-1001");
    screen.getByRole("button", { name: "Open ticket T-1001" }).focus();
    await user.keyboard("{Enter}");
    const receipt = await screen.findByRole("article", { name: "Receipt" });
    expect(within(receipt).getByText("COFFEE LARGE")).toBeInTheDocument();
    expect(within(receipt).getByText(/Hot drinks/)).toBeInTheDocument();
    expect(within(receipt).getByText("Noel (#91)")).toBeInTheDocument();
    expect(within(receipt).getByText("Cash")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open full page" }))
      .toHaveAttribute("href", "/transactions/9");

    await user.click(screen.getByRole("button", { name: "Close receipt" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Receipt" })).not.toBeInTheDocument());
  });

  it("opens a ticket's own page on a narrow window", async () => {
    narrowWindow();
    mockFetch({ "GET /api/v2/posimport/transactions": { body: list() } });
    renderRoute(<Transactions />, { path: "/transactions" });
    await screen.findByText("T-1001");
    screen.getByRole("button", { name: "Open ticket T-1001" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(await screen.findByText(/Navigated to \/transactions\/9/)).toBeInTheDocument();
  });

  it("sends page and rows per page", async () => {
    const calls = mockFetch({ "GET /api/v2/posimport/transactions": { body: list() } });
    const user = userEvent.setup();
    renderRoute(<Transactions />);
    await screen.findByText("T-1001");
    expect(calls.at(-1)!.url.searchParams.get("per_page")).toBe("50");
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("page")).toBe("2"));
    await user.selectOptions(screen.getByLabelText("Rows per page"), "25");
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("per_page")).toBe("25"));
    expect(calls.at(-1)!.url.searchParams.get("page")).toBe("1");
  });

  it("shows the empty state and a retry on failure", async () => {
    mockFetch({ "GET /api/v2/posimport/transactions": { body: list({ rows: [], total: 0, total_pages: 1, voided_count: 0 }) } });
    const { unmount } = renderRoute(<Transactions />);
    expect(await screen.findByText("No transactions in this range")).toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    mockFetch({ "GET /api/v2/posimport/transactions": { status: 500, body: { detail: "x" } } });
    renderRoute(<Transactions />);
    expect(await screen.findByText("Could not load transactions.")).toBeInTheDocument();
  });

  it("names cashiers in a popup and saves only what changed", async () => {
    const calls = mockFetch({
      "GET /api/v2/posimport/transactions": { body: list() },
      "GET /api/v2/posimport/cashiers": {
        body: { rows: [
          { cashier_id: "91", name: "", ticket_count: 70, last_seen: "2026-10-03" },
          { cashier_id: "92", name: "Noel", ticket_count: 10, last_seen: "2026-10-02" },
        ] },
      },
      "PUT /api/v2/posimport/cashiers": { body: { rows: [] } },
    });
    const user = userEvent.setup();
    renderRoute(<Transactions />);
    await screen.findByText("T-1001");
    await user.click(screen.getByRole("button", { name: "Cashier names" }));
    const field = await screen.findByLabelText("Name for cashier 91");
    expect(screen.getByLabelText("Name for cashier 92")).toHaveValue("Noel");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.type(field, "Tania");
    await user.click(save);
    await waitFor(() => expect(callsTo(calls, "PUT /api/v2/posimport/cashiers")).toHaveLength(1));
    expect(callsTo(calls, "PUT /api/v2/posimport/cashiers")[0].body).toEqual({
      cashiers: [{ cashier_id: "91", name: "Tania" }],
    });
    expect(await screen.findByText("Cashier names saved")).toBeInTheDocument();
  });

  it("hides Cashier names from someone who cannot change the store's setup", async () => {
    signInAs({ without: ["day_close.update"] });
    mockFetch({ "GET /api/v2/posimport/transactions": { body: list() } });
    renderRoute(<Transactions />);
    await screen.findByText("T-1001");
    expect(screen.queryByRole("button", { name: "Cashier names" })).not.toBeInTheDocument();
  });

  it("reads in Spanish", async () => {
    setLanguage("es");
    mockFetch({ "GET /api/v2/posimport/transactions": { body: list({
      rows: [{ ...ticket, kind: "void", training_mode: true }],
    }) } });
    renderRoute(<Transactions />);
    const row = (await screen.findByText("T-1001")).closest("tr")!;
    expect(row).toHaveTextContent("anulado");
    expect(row).toHaveTextContent("artículo anulado");
    expect(row).toHaveTextContent("práctica");
    expect(screen.getByRole("heading", { name: /Transacciones/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sin venta (5)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nombres de cajeros" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(expect.arrayContaining(["Hora", "Caja", "Cajero", "Artículos"]));
    expect(englishLeftovers(document.body, ["posTx."])).toEqual([]);
  });
});
