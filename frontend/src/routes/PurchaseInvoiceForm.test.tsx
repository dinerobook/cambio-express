import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PurchaseInvoiceForm from "./PurchaseInvoiceForm";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";

// Purchase invoice form. Pinned here:
//   - Line unit cost / line total are <MoneyInput>s; the API gets the
//     same numbers as before, and a blank line total still means
//     "derive it" (line_total: null).
//   - Editing an invoice sends its lines' money back unchanged.
//   - A refused save shows the server's reason and stays on the page;
//     a failed load offers Retry.

const useInvoice = vi.fn();
const createInvoice = vi.fn();
const updateInvoice = vi.fn();

vi.mock("../api/catalog", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/catalog")>();
  return {
    ...real,
    useInvoice: (...a: unknown[]) => useInvoice(...a),
    useVendors: () => ({
      data: { vendors: [{ id: 3, name: "Coca-Cola Bottling" }] },
      isLoading: false,
    }),
    createInvoice: (...a: unknown[]) => createInvoice(...a),
    updateInvoice: (...a: unknown[]) => updateInvoice(...a),
    lookupItemByCode: vi.fn(() => Promise.resolve(null)),
  };
});

const EXISTING = {
  id: 5, vendor_id: 3, vendor_name: "Coca-Cola Bottling",
  invoice_number: "INV-77", invoice_date: "2026-10-01", due_date: null,
  subtotal: 120, tax: 0, other: 4.5, total: 124.5, status: "open",
  paid_on: null, notes: "", line_count: 1,
  lines: [{
    id: 1, item_id: null, item_name: "", description: "Cola cases",
    quantity: 6, unit_cost: 19.99, line_total: 119.94,
  }],
};

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/purchase-invoices" element={<p>invoice list</p>} />
            <Route path="/purchase-invoices/new" element={<PurchaseInvoiceForm />} />
            <Route path="/purchase-invoices/:id" element={<PurchaseInvoiceForm />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function fillHeader(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Vendor"), "3");
  await user.type(screen.getByLabelText("Invoice #"), "INV-1");
  await user.type(screen.getByLabelText(/^Merchandise subtotal/), "10");
}

describe("PurchaseInvoiceForm", () => {
  beforeEach(() => {
    useInvoice.mockReset();
    useInvoice.mockReturnValue({
      data: undefined, isLoading: false, isError: false, refetch: vi.fn(),
    });
    createInvoice.mockReset();
    createInvoice.mockResolvedValue({ invoice: EXISTING, items_cost_updated: 0 });
    updateInvoice.mockReset();
    updateInvoice.mockResolvedValue({ invoice: EXISTING, items_cost_updated: 0 });
  });

  it("saves a line's unit cost, and a blank line total as 'derive it'", async () => {
    const user = userEvent.setup();
    renderAt("/purchase-invoices/new");
    await fillHeader(user);
    await user.click(screen.getByRole("button", { name: "+ Add line" }));
    await user.type(screen.getByLabelText("Description"), "Ice bags");
    await user.clear(screen.getByLabelText("Qty"));
    await user.type(screen.getByLabelText("Qty"), "4");
    await user.type(screen.getByLabelText("Line 1 unit cost"), "2.5");
    // qty × cost shows in the running total before save.
    expect(screen.getByText("Lines:").parentElement).toHaveTextContent("$10.00");
    await user.click(screen.getByRole("button", { name: "Add invoice" }));

    await waitFor(() => expect(createInvoice).toHaveBeenCalledTimes(1));
    expect(createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      vendor_id: 3,
      invoice_number: "INV-1",
      subtotal: 10,
      lines: [{
        item_id: null, description: "Ice bags", quantity: 4,
        unit_cost: 2.5, line_total: null,
      }],
    }));
    expect(await screen.findByText("Invoice saved.")).toBeInTheDocument();
    expect(screen.getByText("invoice list")).toBeInTheDocument();
  });

  it("sends a keyed line total as a number", async () => {
    const user = userEvent.setup();
    renderAt("/purchase-invoices/new");
    await fillHeader(user);
    await user.click(screen.getByRole("button", { name: "+ Add line" }));
    await user.type(screen.getByLabelText("Description"), "Freight");
    await user.type(screen.getByLabelText("Line 1 unit cost"), "3");
    await user.type(screen.getByLabelText("Line 1 total"), "9.99");
    await user.click(screen.getByRole("button", { name: "Add invoice" }));

    await waitFor(() => expect(createInvoice).toHaveBeenCalledTimes(1));
    const body = createInvoice.mock.calls[0][0];
    expect(body.lines[0]).toMatchObject({ unit_cost: 3, line_total: 9.99 });
  });

  it("edits an invoice and sends its lines' money back unchanged", async () => {
    useInvoice.mockReturnValue({
      data: { invoice: EXISTING }, isLoading: false, isError: false,
      refetch: vi.fn(),
    });
    const user = userEvent.setup();
    renderAt("/purchase-invoices/5");
    expect(screen.getByLabelText("Line 1 unit cost")).toHaveValue("19.99");
    expect(screen.getByLabelText("Line 1 total")).toHaveValue("119.94");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateInvoice).toHaveBeenCalledTimes(1));
    expect(updateInvoice).toHaveBeenCalledWith(5, expect.objectContaining({
      subtotal: 120,
      other: 4.5,
      lines: [{
        item_id: null, description: "Cola cases", quantity: 6,
        unit_cost: 19.99, line_total: 119.94,
      }],
    }));
  });

  it("shows the server's reason when a save is refused and stays put", async () => {
    createInvoice.mockRejectedValue(
      new ApiError(409, "Invoice INV-1 already exists for this vendor.", null),
    );
    const user = userEvent.setup();
    renderAt("/purchase-invoices/new");
    await fillHeader(user);
    await user.click(screen.getByRole("button", { name: "Add invoice" }));
    expect(
      await screen.findByText("Invoice INV-1 already exists for this vendor."),
    ).toBeInTheDocument();
    expect(screen.queryByText("invoice list")).toBeNull();
  });

  it("a failed load offers a Retry that refetches", async () => {
    const refetch = vi.fn();
    useInvoice.mockReturnValue({
      data: undefined, isLoading: false, isError: true, refetch,
    });
    renderAt("/purchase-invoices/5");
    expect(screen.getByText("Could not load the invoice.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
