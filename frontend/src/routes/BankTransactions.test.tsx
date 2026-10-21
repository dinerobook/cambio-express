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
const useBankTransactions = vi.fn();
const EMPTY = {
  data: {
    rows: [], total: 0, page: 1, per_page: 50, total_pages: 1,
    page_total_cents: 0, uncategorized_count: 0,
  },
  isLoading: false, isError: false, refetch: vi.fn(),
};

vi.mock("../api/bankSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/bankSync")>();
  return {
    ...real,
    syncBankTransactions: (...a: unknown[]) => syncBankTransactions(...a),
    useBankAccounts: () => ({ data: { rows: [] }, isLoading: false, isError: false }),
    useBankCategories: () => ({ data: { groups: [] }, isLoading: false, isError: false }),
    useBankTransactions: (...a: unknown[]) => useBankTransactions(...a) ?? EMPTY,
  };
});

function renderPage(at = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[at]}>
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

describe("BankTransactions list", () => {
  const row = {
    id: 5, posted_at: "2026-10-03T12:00:00", description: "REMOTE DEPOSIT FEE",
    account_id: 1, account_label: "MSB ••0230", category_slug: "",
    amount: -2.5, amount_cents: -250, booked_on: null,
  };
  const last = () => useBankTransactions.mock.lastCall![0];

  beforeEach(() => {
    useBankTransactions.mockReset();
    useBankTransactions.mockReturnValue({
      ...EMPTY,
      data: {
        ...EMPTY.data, rows: [row], total: 70, total_pages: 2,
        page_total_cents: -250,
      },
    });
    window.localStorage.removeItem("db.page_size.bank-transactions");
  });

  it("shows rows, the row range and the page total", () => {
    renderPage();
    expect(screen.getByText("REMOTE DEPOSIT FEE")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 70")).toBeInTheDocument();
    expect(screen.getByText(/Page total/)).toHaveTextContent("-$2.50");
    expect(last()).toMatchObject({ sort: "posted", dir: "desc", page: 1, per_page: 50 });
  });

  it("searches as you type, from two characters, back on page 1", async () => {
    const user = userEvent.setup();
    renderPage("/?page=2");
    expect(last().page).toBe(2);
    await user.type(screen.getByLabelText("Search"), "f");
    expect(last().q).toBe("");
    await user.type(screen.getByLabelText("Search"), "ee");
    await waitFor(() => expect(last()).toMatchObject({ q: "fee", page: 1 }));
  });

  it("sorts by a clicked column and changes rows per page", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /Amount/ }));
    await waitFor(() => expect(last()).toMatchObject({ sort: "amount", dir: "desc" }));
    await user.selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() => expect(last().per_page).toBe(100));
  });
});

