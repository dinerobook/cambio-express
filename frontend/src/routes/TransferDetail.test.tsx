import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TransferDetail from "./TransferDetail";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Transfer detail: the money breakdown is shown as stored and obeys
// total_collected = send_amount + fee + federal_tax; the Edit link is
// only offered to someone who may edit (no access, no control).

const useTransfer = vi.fn();

vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return { ...real, useTransfer: (...a: unknown[]) => useTransfer(...a) };
});

const transfer = {
  id: 12, send_date: "2026-10-03", company: "Intermex",
  service_type: "Money Transfer", sender_name: "Maria Lopez",
  recipient_name: "Juan Garcia", country: "Mexico",
  confirm_number: "ABC123", send_amount: 1000, fee: 7.5, federal_tax: 10,
  total_collected: 1017.5, status: "Sent", batch_id: "", employee_name: "Rosa",
};

function renderPage(path = "/transfers/12") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/transfers/:id" element={<TransferDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function rowValue(label: string): string {
  const row = screen.getByText(label).closest("div")!;
  return within(row).getAllByText(/./).at(-1)!.textContent ?? "";
}

describe("TransferDetail", () => {
  beforeEach(() => {
    useTransfer.mockReset();
    useTransfer.mockReturnValue({
      data: { transfer }, isLoading: false, isError: false, refetch: vi.fn(),
    });
  });

  it("shows the amounts with total = send amount + fee + federal tax", () => {
    renderPage();
    expect(rowValue("Send amount")).toBe("$1,000.00");
    expect(rowValue("Fee")).toBe("$7.50");
    expect(rowValue("Federal tax")).toBe("$10.00");
    expect(rowValue("Total collected")).toBe("$1,017.50");
    expect(transfer.send_amount + transfer.fee + transfer.federal_tax)
      .toBe(transfer.total_collected);
  });

  it("shows parties, references and shows a dash for blanks", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Transfer #12" })).toBeInTheDocument();
    expect(screen.getByText("Maria Lopez")).toBeInTheDocument();
    expect(screen.getByText("Juan Garcia")).toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(rowValue("Batch ID")).toBe("—");
  });

  it("links Edit to this transfer's edit page", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Edit" }))
      .toHaveAttribute("href", "/transfers/12/edit");
  });

  it("hides Edit from someone without transfers.update", () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee",
      permissions: ["transfers.read"],
    });
    renderPage();
    expect(screen.getByRole("heading", { name: "Transfer #12" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("offers a retry when the load fails", async () => {
    const refetch = vi.fn();
    useTransfer.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new Error("Transfer not found"), refetch,
    });
    renderPage();
    expect(screen.getByText("Transfer not found")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("rejects a non-numeric id without fetching", () => {
    renderPage("/transfers/abc");
    expect(screen.getByText("Invalid transfer ID.")).toBeInTheDocument();
  });
});
