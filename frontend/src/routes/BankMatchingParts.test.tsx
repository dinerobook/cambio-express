import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BooksCell, BooksSummary, MatchReviewModal, PossibleDoublesCard,
} from "./BankMatching";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { TEST_ADMIN } from "../test/setup";
import type { BankTransactionRow, MatchCandidate } from "../api/bankSync";

// Component-level tests for the bank matching parts (#980); the page
// flows live in BankMatching.test.tsx. These cover what a person can
// do with each row status, who may do it (bank_sync.update to match,
// bank_dismiss.update to dismiss / restore), and that every
// destructive step asks first and reports a refusal in place.

const api = {
  dismissTransactions: vi.fn(),
  keepTypedEntry: vi.fn(),
  matchTransaction: vi.fn(),
  rejectMatch: vi.fn(),
  restoreTransaction: vi.fn(),
  runMatching: vi.fn(),
  unmatchTransaction: vi.fn(),
};
const candidates = vi.fn();
const doubles = vi.fn();

vi.mock("../api/bankSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/bankSync")>();
  return {
    ...real,
    dismissTransactions: (...a: unknown[]) => api.dismissTransactions(...a),
    keepTypedEntry: (...a: unknown[]) => api.keepTypedEntry(...a),
    matchTransaction: (...a: unknown[]) => api.matchTransaction(...a),
    rejectMatch: (...a: unknown[]) => api.rejectMatch(...a),
    restoreTransaction: (...a: unknown[]) => api.restoreTransaction(...a),
    runMatching: (...a: unknown[]) => api.runMatching(...a),
    unmatchTransaction: (...a: unknown[]) => api.unmatchTransaction(...a),
    useMatchCandidates: () => candidates(),
    usePossibleDoubles: () => doubles(),
  };
});

function withPerms(perms: string[]) {
  window.localStorage.setItem(
    "db.identity", JSON.stringify({ ...TEST_ADMIN, role: "employee", permissions: perms }),
  );
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function row(over: Partial<BankTransactionRow> = {}): BankTransactionRow {
  return {
    id: 7, posted_at: "2026-10-20T12:00:00", description: "DEPOSIT 1234",
    amount_cents: 50000, amount: 500, currency: "usd", status: "posted",
    category_slug: "", account_id: 1, account_label: "Checking ••0230",
    daily_line_item_id: null, booked_on: "", report_date_override: "",
    bank_date: "2026-10-20", books_status: "not_on_books", matched_entries: [],
    ...over,
  };
}

const CANDIDATE: MatchCandidate = {
  line_ids: [41], kind: "check_deposit", kind_label: "Check deposit",
  report_date: "2026-10-19", days_from_bank: 1, by_check_number: false,
  entries: [{ id: 41, amount: 500, note: "Smith" }],
} as unknown as MatchCandidate;

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  candidates.mockReturnValue({
    data: { candidates: [CANDIDATE] }, isLoading: false, isError: false, refetch: vi.fn(),
  });
  doubles.mockReturnValue({ data: { rows: [] } });
});

describe("BooksCell", () => {
  it("shows the status pill and the matched entry, linked to its day", () => {
    wrap(<BooksCell row={row({
      books_status: "matched",
      matched_entries: [{ id: 41, kind_label: "Check deposit", report_date: "2026-10-19" }] as never,
    })} />);
    expect(screen.getByText("Matched")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /check deposit/i }))
      .toHaveAttribute("href", "/daily/edit?date=2026-10-19");
  });

  it("asks before unmatching and unmatches on confirm", async () => {
    api.unmatchTransaction.mockResolvedValue({});
    wrap(<BooksCell row={row({
      books_status: "matched",
      matched_entries: [{ id: 41, kind_label: "Check deposit", report_date: "2026-10-19" }] as never,
    })} />);
    await userEvent.click(screen.getByRole("button", { name: "Unmatch" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Unmatch this transaction?")).toBeInTheDocument();
    expect(api.unmatchTransaction).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Unmatch" }));
    await waitFor(() => expect(api.unmatchTransaction).toHaveBeenCalledWith(7));
    expect(await screen.findByText("Unmatched.")).toBeInTheDocument();
  });

  it("shows a refused unmatch inside the dialog", async () => {
    api.unmatchTransaction.mockRejectedValue(new ApiError(409, "That day is locked.", null));
    wrap(<BooksCell row={row({ books_status: "matched", matched_entries: [] })} />);
    await userEvent.click(screen.getByRole("button", { name: "Unmatch" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Unmatch" }));
    expect(await within(dialog).findByText("That day is locked.")).toBeInTheDocument();
  });

  it("dismisses a row not on the books after a confirm", async () => {
    api.dismissTransactions.mockResolvedValue({ dismissed: 1, skipped: 0 });
    wrap(<BooksCell row={row()} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.dismissTransactions).toHaveBeenCalledWith({ ids: [7] }));
  });

  it("restores a dismissed row", async () => {
    api.restoreTransaction.mockResolvedValue({});
    wrap(<BooksCell row={row({ books_status: "dismissed" })} />);
    expect(screen.getByText("Dismissed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(api.restoreTransaction).toHaveBeenCalledWith(7));
    expect(await screen.findByText("Restored. It needs review again.")).toBeInTheDocument();
  });

  it("never offers dismiss on a row already on the books", () => {
    wrap(<BooksCell row={row({ books_status: "added", category_slug: "check_deposit" })} />);
    expect(screen.getByText("Added from bank")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("hides match and dismiss controls from someone without the rights", () => {
    withPerms(["bank_sync.read"]);
    wrap(<BooksCell row={row({ books_status: "suggested" })} />);
    expect(screen.getByText("Check match")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("lets someone match without letting them dismiss", () => {
    withPerms(["bank_sync.read", "bank_sync.update"]);
    wrap(<BooksCell row={row()} />);
    expect(screen.getByRole("button", { name: "Find in daily book" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("renders nothing for a P&L or other tag", () => {
    const { container } = wrap(<BooksCell row={row({ books_status: "", category_slug: "pl_rent" })} />);
    expect(container.querySelector("[class*=booksCell]")).toBeNull();
  });
});

describe("MatchReviewModal", () => {
  it("matches the picked entry and closes", async () => {
    api.matchTransaction.mockResolvedValue({});
    const onClose = vi.fn();
    wrap(<MatchReviewModal row={row({ books_status: "suggested" })} onClose={onClose} />);
    expect(screen.getByText("Check deposit")).toBeInTheDocument();
    expect(screen.getByText(/1 day before the bank/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yes, same money" }));
    await waitFor(() => expect(api.matchTransaction).toHaveBeenCalledWith(7, [41]));
    expect(onClose).toHaveBeenCalled();
  });

  it("records a no and keeps the dialog open", async () => {
    api.rejectMatch.mockResolvedValue({});
    const onClose = vi.fn();
    wrap(<MatchReviewModal row={row()} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "No, different" }));
    await waitFor(() => expect(api.rejectMatch).toHaveBeenCalledWith(7, [41]));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a refused match as an error and stays open", async () => {
    api.matchTransaction.mockRejectedValue(new ApiError(409, "This transaction is already matched.", null));
    const onClose = vi.fn();
    wrap(<MatchReviewModal row={row()} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Yes, same money" }));
    expect(await screen.findByText("This transaction is already matched.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says so when nothing in the daily book could be it", () => {
    candidates.mockReturnValue({ data: { candidates: [] }, isLoading: false, isError: false, refetch: vi.fn() });
    wrap(<MatchReviewModal row={row()} onClose={vi.fn()} />);
    expect(screen.getByText(/Nothing in the daily book has this amount/)).toBeInTheDocument();
  });

  it("offers a retry when the entries fail to load", async () => {
    const refetch = vi.fn();
    candidates.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(500, "boom", null), refetch,
    });
    wrap(<MatchReviewModal row={row()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe("BooksSummary", () => {
  const counts = { matched: 3, added: 2, to_review: 4, dismissed: 1 };

  it("shows the store-wide counts and toggles the review filter", async () => {
    const onReviewOnly = vi.fn();
    wrap(<BooksSummary counts={counts as never} reviewOnly={false}
      onReviewOnly={onReviewOnly} ticked={[]} onClearTicked={vi.fn()} />);
    expect(screen.getByText(/3 matched/)).toBeInTheDocument();
    expect(screen.getByText("4 to review")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "To review" }));
    expect(onReviewOnly).toHaveBeenCalledWith(true);
  });

  it("runs matching and reports how many it matched", async () => {
    api.runMatching.mockResolvedValue({ matched: 2 });
    wrap(<BooksSummary counts={counts as never} reviewOnly={false}
      onReviewOnly={vi.fn()} ticked={[]} onClearTicked={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Match now" }));
    expect(await screen.findByText("2 transactions matched to the daily book.")).toBeInTheDocument();
  });

  it("dismisses the ticked rows only after a confirm", async () => {
    api.dismissTransactions.mockResolvedValue({ dismissed: 2, skipped: 1 });
    const onClearTicked = vi.fn();
    wrap(<BooksSummary counts={counts as never} reviewOnly={false}
      onReviewOnly={vi.fn()} ticked={[7, 8, 9]} onClearTicked={onClearTicked} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss ticked (3)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Dismiss 3 transactions?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.dismissTransactions).toHaveBeenCalledWith({ ids: [7, 8, 9] }));
    expect(onClearTicked).toHaveBeenCalled();
    expect(await screen.findByText(/2 transactions dismissed\. 1 transaction already on the books left alone\./))
      .toBeInTheDocument();
  });

  it("hides dismiss and Match now from someone without the rights", () => {
    withPerms(["bank_sync.read"]);
    wrap(<BooksSummary counts={counts as never} reviewOnly={false}
      onReviewOnly={vi.fn()} ticked={[7]} onClearTicked={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Match now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dismiss/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "To review" })).toBeInTheDocument();
  });
});

describe("PossibleDoublesCard", () => {
  const DOUBLE = {
    transaction: row({ id: 9, description: "MOBILE DEPOSIT" }),
    bank_entry: { id: 50, kind_label: "Check deposit", amount: 500, report_date: "2026-10-20" },
    typed_entry: { id: 41, kind_label: "Check deposit", amount: 500, report_date: "2026-10-19" },
  };

  it("renders nothing when there are no doubles", () => {
    const { container } = wrap(<PossibleDoublesCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("removes the bank's copy only after a confirm", async () => {
    doubles.mockReturnValue({ data: { rows: [DOUBLE] } });
    api.keepTypedEntry.mockResolvedValue({});
    wrap(<PossibleDoublesCard />);
    await userEvent.click(screen.getByRole("button", { name: "Keep typed entry" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.keepTypedEntry).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove copy" }));
    await waitFor(() => expect(api.keepTypedEntry).toHaveBeenCalledWith(9, 41));
  });

  it("keeps both when told they differ", async () => {
    doubles.mockReturnValue({ data: { rows: [DOUBLE] } });
    api.rejectMatch.mockResolvedValue({});
    wrap(<PossibleDoublesCard />);
    await userEvent.click(screen.getByRole("button", { name: "Not the same" }));
    await waitFor(() => expect(api.rejectMatch).toHaveBeenCalledWith(9, [41]));
    expect(await screen.findByText("Kept both.")).toBeInTheDocument();
  });

  it("offers Keep typed entry only to someone who may delete daily book entries", () => {
    withPerms(["bank_sync.read", "bank_sync.update"]);
    doubles.mockReturnValue({ data: { rows: [DOUBLE] } });
    wrap(<PossibleDoublesCard />);
    expect(screen.queryByRole("button", { name: "Keep typed entry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not the same" })).toBeInTheDocument();
  });
});
