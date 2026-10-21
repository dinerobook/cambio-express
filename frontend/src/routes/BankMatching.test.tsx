import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BankTransactions from "./BankTransactions";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { canDismissRow, dayGap } from "../lib/bankMatching";
import { TEST_ADMIN } from "../test/setup";
import type { BankTransactionRow, MatchCandidate, PossibleDouble } from "../api/bankSync";

// Bank transactions matched to daily book entries (BankSync
// INVARIANTS.md "Matching"), the Bank page's side:
//   - switch off: no Daily book column, no summary, no tick boxes;
//   - switch on: one pill per row (Matched / Added from bank / Check
//     match / Not on books / Dismissed), store-wide counts, and a
//     "To review" filter kept in the URL;
//   - Review asks "Is this already in the daily book?" with Yes / No
//     per candidate; errors stay in the popup;
//   - Unmatch and Dismiss confirm first; Restore brings a row back;
//   - Dismiss is the admin's (bank_dismiss.update), Review / Unmatch
//     need bank_sync.update — without them the buttons are gone;
//   - money in twice is listed, and "Keep typed entry" (needs
//     daily_book.delete) confirms before removing the bank's copy.

const useBankTransactions = vi.fn();
const useMatchCandidates = vi.fn();
const usePossibleDoubles = vi.fn();
const matchTransaction = vi.fn();
const rejectMatch = vi.fn();
const unmatchTransaction = vi.fn();
const keepTypedEntry = vi.fn();
const dismissTransactions = vi.fn();
const restoreTransaction = vi.fn();
const runMatching = vi.fn();

vi.mock("../api/bankSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/bankSync")>();
  return {
    ...real,
    useBankAccounts: () => ACCOUNTS,
    useBankCategories: () => CATEGORIES,
    useBankTransactions: (...a: unknown[]) => useBankTransactions(...a),
    useMatchCandidates: (...a: unknown[]) => useMatchCandidates(...a),
    usePossibleDoubles: (...a: unknown[]) => usePossibleDoubles(...a),
    matchTransaction: (...a: unknown[]) => matchTransaction(...a),
    rejectMatch: (...a: unknown[]) => rejectMatch(...a),
    unmatchTransaction: (...a: unknown[]) => unmatchTransaction(...a),
    keepTypedEntry: (...a: unknown[]) => keepTypedEntry(...a),
    dismissTransactions: (...a: unknown[]) => dismissTransactions(...a),
    restoreTransaction: (...a: unknown[]) => restoreTransaction(...a),
    runMatching: (...a: unknown[]) => runMatching(...a),
  };
});

const ACCOUNTS = { data: { rows: [] }, isLoading: false, isError: false };
const CATEGORIES = { data: { groups: [] }, isLoading: false, isError: false };
const NO_DOUBLES = { data: { rows: [] }, isLoading: false, isError: false };

const txn = (over: Partial<BankTransactionRow>): BankTransactionRow => ({
  id: 1, posted_at: "2026-10-03T12:00:00", description: "",
  account_id: 1, account_label: "MSB ••0230", category_slug: "",
  amount: 500, amount_cents: 50000, booked_on: null, ...over,
} as BankTransactionRow);

const ENTRY = {
  id: 70, report_date: "2026-10-01", kind: "drop", kind_label: "Cash drop",
  amount: 500, note: "evening drop",
};
const MATCHED = txn({
  id: 11, description: "ATM DEPOSIT 11", category_slug: "drop",
  books_status: "matched", matched_entries: [ENTRY],
});
const ADDED = txn({ id: 12, description: "ATM DEPOSIT 12", category_slug: "drop", books_status: "added" });
const SUGGESTED = txn({ id: 13, description: "ATM DEPOSIT 13", category_slug: "drop", books_status: "suggested", suggestion_count: 2 });
const NOT_ON = txn({ id: 14, description: "CHECK 14", category_slug: "check_deposit", books_status: "not_on_books" });
const DISMISSED = txn({ id: 15, description: "OLD 15", books_status: "dismissed", dismissed_at: "2026-10-04T00:00:00" });

function listOf(rows: BankTransactionRow[], matching = true) {
  return {
    data: {
      rows, total: rows.length, page: 1, per_page: 50, total_pages: 1,
      page_total_cents: 0, uncategorized_count: 0,
      matching_enabled: matching,
      books_counts: matching ? { added: 1, matched: 1, to_review: 2, dismissed: 1 } : null,
    },
    isLoading: false, isError: false, refetch: vi.fn(),
  };
}

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

const rowOf = (text: string) => screen.getByText(text).closest("tr")!;
const lastFilters = () => useBankTransactions.mock.lastCall![0];

function withPermissions(drop: string[] = [], add: string[] = []) {
  setCurrentIdentity({
    ...TEST_ADMIN,
    permissions: [...TEST_ADMIN.permissions.filter((p) => !drop.includes(p)), ...add],
  });
}

beforeEach(() => {
  for (const fn of [
    useBankTransactions, useMatchCandidates, usePossibleDoubles, matchTransaction,
    rejectMatch, unmatchTransaction, keepTypedEntry, dismissTransactions,
    restoreTransaction, runMatching,
  ]) fn.mockReset();
  setCurrentIdentity(TEST_ADMIN);
  usePossibleDoubles.mockReturnValue(NO_DOUBLES);
  useMatchCandidates.mockReturnValue({ data: { candidates: [] }, isLoading: false, isError: false, refetch: vi.fn() });
  useBankTransactions.mockReturnValue(listOf([MATCHED, ADDED, SUGGESTED, NOT_ON, DISMISSED]));
  for (const fn of [matchTransaction, rejectMatch, unmatchTransaction, keepTypedEntry, restoreTransaction]) {
    fn.mockResolvedValue({});
  }
  dismissTransactions.mockResolvedValue({ dismissed: 1, skipped: 0 });
  runMatching.mockResolvedValue({ matched: 0 });
});

describe("Bank page, matching switched off", () => {
  it("shows no daily-book column, summary or tick boxes", () => {
    useBankTransactions.mockReturnValue(listOf([txn({ description: "ATM DEPOSIT" })], false));
    renderPage();
    expect(screen.getByText("ATM DEPOSIT")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Daily book" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Select" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Match now" })).not.toBeInTheDocument();
    expect(screen.queryByText("Possibly in the daily book twice")).not.toBeInTheDocument();
  });
});

describe("Bank page, matching switched on", () => {
  it("shows one pill per row and the store's counts", () => {
    renderPage();
    expect(screen.getByRole("columnheader", { name: "Daily book" })).toBeInTheDocument();
    expect(within(rowOf("ATM DEPOSIT 11")).getByText("Matched")).toBeInTheDocument();
    expect(within(rowOf("ATM DEPOSIT 11")).getByRole("link", { name: /Cash drop/ }))
      .toHaveAttribute("href", "/daily/edit?date=2026-10-01");
    expect(within(rowOf("ATM DEPOSIT 12")).getByText("Added from bank")).toBeInTheDocument();
    expect(within(rowOf("ATM DEPOSIT 13")).getByText("Check match")).toBeInTheDocument();
    expect(within(rowOf("CHECK 14")).getByText("Not on books")).toBeInTheDocument();
    expect(within(rowOf("OLD 15")).getByText("Dismissed")).toBeInTheDocument();
    expect(screen.getByText("2 to review")).toBeInTheDocument();
    expect(screen.getByText(/1 matched/)).toBeInTheDocument();
  });

  it("filters to the rows to review, kept in the URL", async () => {
    renderPage();
    expect(lastFilters()).toMatchObject({ books: "" });
    const btn = screen.getByRole("button", { name: "To review" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(btn);
    await waitFor(() => expect(lastFilters()).toMatchObject({ books: "review" }));
    expect(screen.getByRole("button", { name: "Showing to review" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("reads the review filter back from the URL", () => {
    renderPage("/?books=review");
    expect(lastFilters()).toMatchObject({ books: "review" });
  });

  it("offers ticks only on rows nothing is booked for", () => {
    renderPage();
    expect(within(rowOf("ATM DEPOSIT 13")).getByRole("checkbox")).toBeInTheDocument();
    expect(within(rowOf("CHECK 14")).getByRole("checkbox")).toBeInTheDocument();
    for (const t of ["ATM DEPOSIT 11", "ATM DEPOSIT 12", "OLD 15"]) {
      expect(within(rowOf(t)).queryByRole("checkbox")).not.toBeInTheDocument();
    }
  });

  it("Match now reports what it matched", async () => {
    runMatching.mockResolvedValue({ matched: 3 });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Match now" }));
    expect(await screen.findByText("3 transactions matched to the daily book.")).toBeInTheDocument();
  });
});

describe("Review a possible match", () => {
  const CAND: MatchCandidate = {
    line_ids: [70], kind: "drop", kind_label: "Cash drop", report_date: "2026-10-01",
    days_from_bank: 2, by_check_number: false, entries: [ENTRY],
  };

  beforeEach(() => {
    useMatchCandidates.mockReturnValue({
      data: { candidates: [CAND] }, isLoading: false, isError: false, refetch: vi.fn(),
    });
  });

  async function openReview() {
    renderPage();
    await userEvent.click(within(rowOf("ATM DEPOSIT 13")).getByRole("button", { name: "Review" }));
    return screen.getByRole("dialog", { name: "Is this already in the daily book?" });
  }

  it("lists the entries it could be and links them on Yes", async () => {
    const dialog = await openReview();
    expect(dialog).toHaveTextContent("Cash drop");
    expect(dialog).toHaveTextContent("2 days before the bank");
    await userEvent.click(within(dialog).getByRole("button", { name: "Yes, same money" }));
    expect(matchTransaction).toHaveBeenCalledWith(13, [70]);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Is this already in the daily book?" }))
        .not.toBeInTheDocument());
  });

  it("remembers No", async () => {
    const dialog = await openReview();
    await userEvent.click(within(dialog).getByRole("button", { name: "No, different" }));
    expect(rejectMatch).toHaveBeenCalledWith(13, [70]);
    expect(matchTransaction).not.toHaveBeenCalled();
  });

  it("keeps the popup open with the server's reason when it fails", async () => {
    matchTransaction.mockRejectedValue(new ApiError(409, "That entry is already matched.", null));
    const dialog = await openReview();
    await userEvent.click(within(dialog).getByRole("button", { name: "Yes, same money" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already matched");
  });

  it("says so when nothing in the daily book fits", async () => {
    useMatchCandidates.mockReturnValue({
      data: { candidates: [] }, isLoading: false, isError: false, refetch: vi.fn(),
    });
    renderPage();
    await userEvent.click(within(rowOf("CHECK 14")).getByRole("button", { name: "Find in daily book" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Nothing in the daily book has this amount");
  });

  it("shows a retry when the entries fail to load", async () => {
    const refetch = vi.fn();
    useMatchCandidates.mockReturnValue({
      data: undefined, isLoading: false, isError: true, error: new Error("x"), refetch,
    });
    const dialog = await openReview();
    await userEvent.click(within(dialog).getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe("Unmatch, dismiss, restore", () => {
  it("unmatches only after the confirm", async () => {
    renderPage();
    await userEvent.click(within(rowOf("ATM DEPOSIT 11")).getByRole("button", { name: "Unmatch" }));
    const ask = screen.getByRole("dialog", { name: "Unmatch this transaction?" });
    expect(unmatchTransaction).not.toHaveBeenCalled();
    await userEvent.click(within(ask).getByRole("button", { name: "Unmatch" }));
    expect(unmatchTransaction).toHaveBeenCalledWith(11);
  });

  it("dismisses one row after the confirm", async () => {
    renderPage();
    await userEvent.click(within(rowOf("CHECK 14")).getByRole("button", { name: "Dismiss" }));
    const ask = screen.getByRole("dialog", { name: "Dismiss this transaction?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Dismiss" }));
    expect(dismissTransactions).toHaveBeenCalledWith({ ids: [14] });
  });

  it("dismisses the ticked rows together", async () => {
    dismissTransactions.mockResolvedValue({ dismissed: 2, skipped: 0 });
    renderPage();
    await userEvent.click(within(rowOf("ATM DEPOSIT 13")).getByRole("checkbox"));
    await userEvent.click(within(rowOf("CHECK 14")).getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss ticked (2)" }));
    const ask = screen.getByRole("dialog", { name: "Dismiss 2 transactions?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Dismiss" }));
    expect(dismissTransactions).toHaveBeenCalledWith({ ids: [13, 14] });
    expect(await screen.findByText("2 transactions dismissed.")).toBeInTheDocument();
  });

  it("dismisses everything to review before a date, after asking", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss before a date" }));
    const pick = screen.getByRole("dialog", { name: "Dismiss transactions before a date" });
    const cont = within(pick).getByRole("button", { name: "Continue" });
    expect(cont).toBeDisabled();
    await userEvent.type(within(pick).getByLabelText("On or before"), "2026-09-30");
    await userEvent.click(cont);
    const ask = screen.getByRole("dialog", { name: /^Dismiss everything to review up to/ });
    await userEvent.click(within(ask).getByRole("button", { name: "Dismiss" }));
    expect(dismissTransactions).toHaveBeenCalledWith({ before: "2026-09-30" });
  });

  it("shows the server's reason inside the confirm when dismiss fails", async () => {
    dismissTransactions.mockRejectedValue(new ApiError(403, "Only an admin can dismiss.", null));
    renderPage();
    await userEvent.click(within(rowOf("CHECK 14")).getByRole("button", { name: "Dismiss" }));
    const ask = screen.getByRole("dialog", { name: "Dismiss this transaction?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Dismiss" }));
    expect(await within(ask).findByText("Only an admin can dismiss.")).toBeInTheDocument();
  });

  it("restores a dismissed row", async () => {
    renderPage();
    await userEvent.click(within(rowOf("OLD 15")).getByRole("button", { name: "Restore" }));
    expect(restoreTransaction).toHaveBeenCalledWith(15);
  });
});

describe("Who sees what", () => {
  it("hides every dismiss control without bank_dismiss.update", () => {
    withPermissions(["bank_dismiss.update"]);
    renderPage();
    expect(screen.queryByRole("columnheader", { name: "Select" })).not.toBeInTheDocument();
    for (const t of ["ATM DEPOSIT 13", "CHECK 14"]) {
      expect(within(rowOf(t)).queryByRole("checkbox")).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss before a date" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    // Matching itself is still there.
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  it("is read-only without bank_sync.update", () => {
    withPermissions(["bank_sync.update", "bank_dismiss.update"]);
    renderPage();
    expect(within(rowOf("ATM DEPOSIT 11")).getByText("Matched")).toBeInTheDocument();
    for (const name of ["Review", "Find in daily book", "Unmatch", "Match now", "Dismiss"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});

describe("Money in the daily book twice", () => {
  const DOUBLE: PossibleDouble = {
    transaction: txn({
      id: 21, description: "ATM DEPOSIT 21", books_status: "added",
    }) as PossibleDouble["transaction"],
    typed_entry: { ...ENTRY, id: 80, report_date: "2026-10-02" },
    bank_entry: { ...ENTRY, id: 81, report_date: "2026-10-03", note: "ATM DEPOSIT 21" },
  };

  beforeEach(() => {
    usePossibleDoubles.mockReturnValue({ data: { rows: [DOUBLE] }, isLoading: false, isError: false });
  });

  const card = () => screen.getByText("Possibly in the daily book twice").closest("section, div")!.parentElement!;

  it("removes the bank's copy only after the confirm", async () => {
    renderPage();
    await userEvent.click(within(card()).getByRole("button", { name: "Keep typed entry" }));
    const ask = screen.getByRole("dialog", { name: "Remove the bank's copy?" });
    expect(keepTypedEntry).not.toHaveBeenCalled();
    await userEvent.click(within(ask).getByRole("button", { name: "Remove copy" }));
    expect(keepTypedEntry).toHaveBeenCalledWith(21, 80);
  });

  it("keeps both on Not the same", async () => {
    renderPage();
    await userEvent.click(within(card()).getByRole("button", { name: "Not the same" }));
    expect(rejectMatch).toHaveBeenCalledWith(21, [80]);
    expect(keepTypedEntry).not.toHaveBeenCalled();
  });

  it("needs daily_book.delete to remove a copy", () => {
    withPermissions(["daily_book.delete"]);
    renderPage();
    expect(screen.queryByRole("button", { name: "Keep typed entry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not the same" })).toBeInTheDocument();
  });

  it("is hidden when there is nothing in twice", () => {
    usePossibleDoubles.mockReturnValue(NO_DOUBLES);
    renderPage();
    expect(screen.queryByText("Possibly in the daily book twice")).not.toBeInTheDocument();
  });
});

describe("bankMatching helpers", () => {
  it("lets only rows with nothing booked be dismissed", () => {
    expect(canDismissRow(SUGGESTED)).toBe(true);
    expect(canDismissRow(NOT_ON)).toBe(true);
    expect(canDismissRow(txn({ books_status: "" }))).toBe(true);
    expect(canDismissRow(txn({ books_status: "", category_slug: "bank_fee" }))).toBe(false);
    for (const r of [MATCHED, ADDED, DISMISSED]) expect(canDismissRow(r)).toBe(false);
  });

  it("says how far the entry sits from the bank's day", () => {
    expect(dayGap(0)).toBe("same day as the bank");
    expect(dayGap(1)).toBe("1 day before the bank");
    expect(dayGap(3)).toBe("3 days before the bank");
    expect(dayGap(-2)).toBe("2 days after the bank");
  });
});
