// Bank transactions matched to daily book entries — pure helpers
// shared by the Bank page (BankMatching.tsx, BankTransactions.tsx)
// and their tests. BankSync INVARIANTS.md "Matching".

import type { BankTransactionRow } from "../api/bankSync";
import { t, tn, type MessageKey } from "../i18n";

/** The Daily book column's word for each books status — the pill on
 *  the Bank page and the cell in its CSV export. */
export const BOOKS_STATUS_LABELS = {
  matched: "books.matched",
  added: "books.added",
  suggested: "books.suggested",
  not_on_books: "books.notOnBooks",
  dismissed: "books.dismissed",
} as const satisfies Record<string, MessageKey>;

/** ``BOOKS_STATUS_LABELS`` for any status; blank when there is none. */
export function booksStatusLabel(status: string | null | undefined): string {
  const key = Object.hasOwn(BOOKS_STATUS_LABELS, status ?? "")
    ? (BOOKS_STATUS_LABELS as Record<string, MessageKey>)[status ?? ""]
    : undefined;
  return key ? t(key) : "";
}

/** A row an admin can still dismiss: nothing on the books for it
 *  yet (a possible match, not on the books, or untagged). The
 *  server applies the same rule and skips anything else. */
export function canDismissRow(r: BankTransactionRow): boolean {
  return (
    r.books_status === "suggested" || r.books_status === "not_on_books"
    || (r.books_status === "" && !r.category_slug)
  );
}

/** "2 days before the bank" — how far the entry's day sits from the
 *  bank's date (`days_from_bank` = bank date minus entry day). */
export function dayGap(days: number): string {
  if (days === 0) return t("books.sameDay");
  return tn(days > 0 ? "books.daysBefore" : "books.daysAfter", Math.abs(days));
}
