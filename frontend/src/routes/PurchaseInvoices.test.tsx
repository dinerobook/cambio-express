import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PurchaseInvoices from "./PurchaseInvoices";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import type { InvoiceList, InvoiceRow } from "../api/catalog";

// Vendor invoice log. Pinned: rows render with money via fmtMoney2,
// Mark paid / Reopen flip the status (paid carries a paid_on date),
// the add / row actions are hidden without catalog.update, and a
// failed load shows ErrorState with Retry.

const updateInvoice = vi.fn();
const deleteInvoice = vi.fn();
const refetch = vi.fn();
let state: { data?: InvoiceList; isLoading: boolean; isError: boolean };

vi.mock("../api/catalog", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/catalog")>();
  return {
    ...real,
    useInvoices: () => ({ ...state, refetch }),
    useVendors: () => ({ data: { vendors: [{ id: 3, name: "McLane" }] } }),
    updateInvoice: (...a: unknown[]) => updateInvoice(...a),
    deleteInvoice: (...a: unknown[]) => deleteInvoice(...a),
  };
});

function inv(id: number, num: string, over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id, invoice_number: num, vendor_id: 3, vendor_name: "McLane",
    invoice_date: "2026-10-01", due_date: null, line_count: 4, notes: "",
    other: 0, paid_on: null, status: "open", subtotal: 1200, tax: 34.5,
    total: 1234.5, ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/purchase-invoices"]}>
          <Routes>
            <Route path="/purchase-invoices" element={<PurchaseInvoices />} />
            <Route path="/purchase-invoices/:id" element={<p>invoice form</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const rowOf = (num: string) => screen.getByText(num).closest("tr")!;

describe("PurchaseInvoices", () => {
  beforeEach(() => {
    updateInvoice.mockReset();
    updateInvoice.mockResolvedValue({});
    deleteInvoice.mockReset();
    deleteInvoice.mockResolvedValue({});
    refetch.mockReset();
    state = {
      data: {
        rows: [inv(1, "INV-100"), inv(2, "INV-200", { status: "paid", paid_on: "2026-10-05" })],
        total: 2, page: 1, total_pages: 1,
      },
      isLoading: false, isError: false,
    };
  });

  it("lists invoices with money and status", () => {
    renderPage();
    const open = rowOf("INV-100");
    expect(open).toHaveTextContent("$1,234.50");
    expect(within(open).getByText("open")).toBeInTheDocument();
    expect(within(rowOf("INV-200")).getByText("paid 2026-10-05")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "+ Add invoice" })).toBeInTheDocument();
  });

  it("marks an open invoice paid with today's date", async () => {
    renderPage();
    await userEvent.click(within(rowOf("INV-100")).getByRole("button", { name: "Mark paid" }));
    await waitFor(() => expect(updateInvoice).toHaveBeenCalledWith(1, {
      status: "paid", paid_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    }));
  });

  it("reopens a paid invoice", async () => {
    renderPage();
    await userEvent.click(within(rowOf("INV-200")).getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(updateInvoice).toHaveBeenCalledWith(2, { status: "open" }));
  });

  it("toasts a refused status change", async () => {
    updateInvoice.mockRejectedValue(new ApiError(409, "Invoice is locked.", null));
    renderPage();
    await userEvent.click(within(rowOf("INV-100")).getByRole("button", { name: "Mark paid" }));
    expect(await screen.findByText("Invoice is locked.")).toBeInTheDocument();
  });

  it("opens the edit form from Edit", async () => {
    renderPage();
    await userEvent.click(within(rowOf("INV-100")).getByRole("button", { name: "Edit" }));
    expect(await screen.findByText("invoice form")).toBeInTheDocument();
  });

  it("hides Add and the row actions without catalog.update", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "employee", permissions: ["catalog.read"] });
    renderPage();
    expect(screen.queryByRole("link", { name: "+ Add invoice" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark paid" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
  });

  it("shows the empty state", () => {
    state = { data: { rows: [], total: 0, page: 1, total_pages: 0 }, isLoading: false, isError: false };
    renderPage();
    expect(screen.getByText("No invoices yet")).toBeInTheDocument();
  });

  it("shows ErrorState with a working Retry", async () => {
    state = { isLoading: false, isError: true };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load invoices.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  // BUG (UI-STANDARDS §2: destructive action = ConfirmDialog):
  // PurchaseInvoices.tsx wires the row's "Delete" straight to
  // deleteInvoice — one click (or one mis-tap in the mobile sheet)
  // deletes the invoice and its lines with no confirmation.
  it.fails("asks for confirmation before deleting an invoice", async () => {
    renderPage();
    await userEvent.click(within(rowOf("INV-100")).getByRole("button", { name: "Delete" }));
    expect(deleteInvoice).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
