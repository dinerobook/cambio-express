import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TransferReceipt from "./TransferReceipt";

// The printed receipt is what the customer takes home: the money must
// read once with a single "$" and add up (send + fee + federal tax =
// total paid).

const useTransferReceipt = vi.fn();

vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return {
    ...real,
    useTransferReceipt: (...a: unknown[]) => useTransferReceipt(...a),
  };
});

const data = {
  store: {
    name: "Casa Cambio", address: "1 Main St", phone: "555-0100",
    email: "hi@casa.test", receipt_logo_url: "", receipt_footer: "",
    receipt_tax_id: "99-123",
  },
  transfer: {
    id: 12, send_date: "2026-10-03", created_at: "", company: "Intermex",
    service_type: "Money Transfer", sender_name: "Maria Lopez",
    sender_phone: "5551112222", sender_phone_country: "+1",
    sender_address: "", recipient_name: "Juan Garcia",
    recipient_phone: "", country: "Mexico", confirm_number: "ABC123",
    send_amount: 1000, fee: 7.5, federal_tax: 10, total_collected: 1017.5,
    status: "Sent", employee_name: "Rosa",
  },
};

function renderPage(path = "/transfers/12/receipt") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/transfers/:id/receipt" element={<TransferReceipt />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TransferReceipt", () => {
  beforeEach(() => {
    useTransferReceipt.mockReset();
    useTransferReceipt.mockReturnValue({
      data, isLoading: false, isError: false, refetch: vi.fn(),
    });
  });

  it("shows the total paid with one dollar sign, matching the parts", () => {
    renderPage();
    const receipt = screen.getByRole("article", { name: "Transfer receipt" });
    expect(receipt).not.toHaveTextContent("$$");
    expect(within(receipt).getByText("Customer paid").nextSibling)
      .toHaveTextContent(/^\$1,017\.50$/);
    const cells = within(receipt).getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toEqual([
      "Money Transfer", "Intermex", "$1,000.00", "$7.50", "$10.00", "$1,017.50",
    ]);
  });

  it("shows store, parties and the cashier", () => {
    renderPage();
    expect(screen.getByText("Casa Cambio")).toBeInTheDocument();
    expect(screen.getByText("Tax ID: 99-123")).toBeInTheDocument();
    expect(screen.getByText("Maria Lopez")).toBeInTheDocument();
    expect(screen.getByText("+1 5551112222")).toBeInTheDocument();
    expect(screen.getByText("Cashier (Rosa)")).toBeInTheDocument();
  });

  it("offers a retry when the receipt cannot load", () => {
    useTransferReceipt.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new Error("nope"), refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText("Couldn't load receipt: nope")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
