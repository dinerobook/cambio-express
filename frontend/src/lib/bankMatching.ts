// Bank transactions matched to daily book entries — pure helpers
// shared by the Bank page (BankMatching.tsx, BankTransactions.tsx)
// and their tests. BankSync INVARIANTS.md "Matching".

import type { BankTransactionRow } from "../api/bankSync";
import { fmtCount } from "./formatters";

/** The Daily book column's word for each books status — the pill on
 *  the Bank page and the cell in its CSV export. */
export const BOOKS_STATUS_LABELS = {
  matched: "Matched",
  added: "Added from bank",
  suggested: "Check match",
  not_on_books: "Not on books",
  dismissed: "Dismissed",
} as const;

/** ``BOOKS_STATUS_LABELS`` for any status; blank when there is none. */
export function booksStatusLabel(status: string | null | undefined): string {
  return (BOOKS_STATUS_LABELS as Record<string, string>)[status ?? ""] ?? "";
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
  if (days === 0) return "same day as the bank";
  const gap = fmtCount(Math.abs(days), "day");
  return days > 0 ? `${gap} before the bank` : `${gap} after the bank`;
}
