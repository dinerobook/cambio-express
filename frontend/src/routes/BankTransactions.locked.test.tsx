import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BankTransactions from "./BankTransactions";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";

// A locked daily book is view only. A transaction whose line sits on
// a locked day can't be untagged or re-tagged (the server answers
// 409 with that day); the row must say to unlock the day — offering
// "book on another day" would only fail again. A booking onto a
// locked day still offers another day.

const categorizeTransaction = vi.fn();
const uncategorizeTransaction = vi.fn();

const ROW = {
  id: 7, posted_at: "2026-05-06T10:00:00", description: "CASH EXPENSE",
  amount_cents: -4000, amount: -40, currency: "usd", status: "posted",
  category_slug: "cash_expense", account_id: 1, account_label: "Bank ••0230",
  daily_line_item_id: 11, booked_on: "2026-05-06",
  report_date_override: "", bank_date: "2026-05-06",
};

vi.mock("../api/bankSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/bankSync")>();
  return {
    ...real,
    categorizeTransaction: (...a: unknown[]) => categorizeTransaction(...a),
    uncategorizeTransaction: (...a: unknown[]) => uncategorizeTransaction(...a),
    useBankAccounts: () => ({ data: { rows: [] }, isLoading: false, isError: false }),
    useBankCategories: () => ({
      data: {
        groups: [{
          label: "Daily book", posts_to_daily: true,
          options: [
            { slug: "cash_expense", label: "Cash expense" },
            { slug: "cash_purchase", label: "Cash purchase" },
          ],
        }],
      },
      isLoading: false, isError: false,
    }),
    useBankTransactions: () => ({
      data: {
        rows: [ROW], total: 1, page: 1, per_page: 50, total_pages: 1,
        page_total_cents: -4000, uncategorized_count: 0,
      },
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
  };
});

function locked(day: string) {
  return new ApiError(409, "locked", {
    detail: { code: "daily_book_locked", report_date: day, message: "locked" },
  });
}

/** The row's category picker (the filter bar has one labelled
 *  "Category" too). */
function rowCategory() {
  const all = screen.getAllByRole("combobox", { name: "Category" });
  return all[all.length - 1];
}

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

describe("BankTransactions on a locked daily book", () => {
  beforeEach(() => {
    categorizeTransaction.mockReset();
    uncategorizeTransaction.mockReset();
  });

  it("untagging a line on a locked day says to unlock it, with no other day", async () => {
    uncategorizeTransaction.mockRejectedValue(locked("2026-05-06"));
    renderPage();
    await userEvent.selectOptions(rowCategory(), "");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/is locked, so the line this transaction booked there can.t change/);
    expect(alert.querySelector("a")).toHaveAttribute("href", "/daily/edit?date=2026-05-06");
    expect(screen.queryByLabelText("Book on date")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("re-tagging a line on a locked day is refused the same way", async () => {
    categorizeTransaction.mockRejectedValue(locked("2026-05-06"));
    renderPage();
    await userEvent.selectOptions(rowCategory(), "cash_purchase");
    expect(await screen.findByRole("alert")).toHaveTextContent(/unlock it first/);
    expect(screen.queryByLabelText("Book on date")).not.toBeInTheDocument();
  });

  it("booking onto a different locked day still offers another day", async () => {
    categorizeTransaction.mockRejectedValue(locked("2026-05-09"));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Change day" }));
    await userEvent.type(screen.getByLabelText("Book on date"), "2026-05-09");
    await userEvent.click(screen.getByRole("button", { name: "Book" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/or book on another day/);
    expect(screen.getByLabelText("Book on date")).toBeInTheDocument();
  });
});
