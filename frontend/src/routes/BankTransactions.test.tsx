import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BankTransactions from "./BankTransactions";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";

// "Sync transactions" result reporting. A failed sync used to land
// in the same green success banner as a good one, so an operator
// saw "Bank feed unavailable" styled as a win. Success is now a
// success toast; failure is an error toast (role="alert").

const syncBankTransactions = vi.fn();

vi.mock("../api/bankSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/bankSync")>();
  return {
    ...real,
    syncBankTransactions: (...a: unknown[]) => syncBankTransactions(...a),
    useBankAccounts: () => ({ data: { rows: [] }, isLoading: false, isError: false }),
    useBankCategories: () => ({ data: { groups: [] }, isLoading: false, isError: false }),
    useBankTransactions: () => ({
      data: {
        rows: [], total: 0, page: 1, per_page: 50, total_pages: 1,
        page_total_cents: 0, uncategorized_count: 0,
      },
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
  };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <BankTransactions />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("BankTransactions sync", () => {
  beforeEach(() => {
    syncBankTransactions.mockReset();
  });

  it("reports a successful sync as a success toast", async () => {
    syncBankTransactions.mockResolvedValue({ new_rows: 3 });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /sync transactions/i }));
    const msg = await screen.findByText("Synced 3 new transactions.");
    expect(msg.closest("[role]")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses the singular for one new row", async () => {
    syncBankTransactions.mockResolvedValue({ new_rows: 1 });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /sync transactions/i }));
    expect(await screen.findByText("Synced 1 new transaction.")).toBeInTheDocument();
  });

  it("reports a failed sync as an error, with the server's message", async () => {
    syncBankTransactions.mockRejectedValue(
      new ApiError(502, "Bank feed unavailable", null),
    );
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /sync transactions/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Bank feed unavailable");
    expect(screen.queryByText(/^Synced/)).not.toBeInTheDocument();
  });

  it("falls back to a generic message for a non-API failure", async () => {
    syncBankTransactions.mockRejectedValue(new TypeError("fetch failed"));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /sync transactions/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sync failed.");
  });

  it("re-enables the button once the sync settles", async () => {
    syncBankTransactions.mockRejectedValue(new Error("x"));
    renderPage();
    const btn = screen.getByRole("button", { name: /sync transactions/i });
    await userEvent.click(btn);
    await waitFor(() => expect(btn).not.toBeDisabled());
  });
});
