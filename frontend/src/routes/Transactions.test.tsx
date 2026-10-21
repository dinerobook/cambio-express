import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import Transactions from "./Transactions";
import { mockFetch } from "../test/fetchMock";
import { renderRoute } from "../test/renderRoute";

// Register tickets: KPIs + the shared table; a void is flagged, a
// row opens its ticket (mouse or keyboard), the pager and rows per
// page reach the API.

const ticket = {
  id: 9, transaction_no: "T-1001", business_date: "2026-10-03",
  receipt_at: null, register_id: "R1", cashier_id: "C7", item_count: 3,
  tax: 0.84, grand_total: 12.34, gross: 11.5, kind: "sale",
  has_voided_line: true, training_mode: false, offline: false, suspended: false,
};

const list = (over: Record<string, unknown> = {}) => ({
  rows: [ticket], total: 80, page: 1, total_pages: 2,
  total_grand: 999.5, voided_count: 1, ...over,
});

describe("POS transactions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem("db.page_size.pos-transactions");
  });

  it("lists tickets with the void flagged and money right-aligned", async () => {
    mockFetch({ "GET /api/v2/posimport/transactions": { body: list() } });
    renderRoute(<Transactions />);
    const row = (await screen.findByText("T-1001")).closest("tr")!;
    expect(row).toHaveTextContent("voided item");
    expect(screen.getByText("$12.34").closest("td")).toHaveStyle({ textAlign: "right" });
    expect(screen.getByText("Showing 1–1 of 80")).toBeInTheDocument();
  });

  it("opens a ticket from its row by keyboard", async () => {
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
});
