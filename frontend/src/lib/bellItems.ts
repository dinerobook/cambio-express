import type { BellItem, BellKind } from "../api/bell";
import { addDaysIso, formatDayLabel } from "./datetime";
import { fmtCount, fmtMoney2 } from "./formatters";

// The one table that turns a bell item from the server into words,
// an icon and a link. The server sends only a kind and its numbers
// (api/Modules/Notifications/Services/bell); everything a person
// reads lives here, so the Spanish work has one place to translate.
//
// `Record<BellKind, …>`: a kind added on the server without its row
// here fails `npm run build` (the kinds come from the generated
// OpenAPI types), and tests/Modules/Notifications/test_bell_registry.py
// fails too. Rules for a new row: UI-STANDARDS §10 "The bell".

export type BellIcon = "book" | "cash" | "bank" | "check";

export interface BellContext {
  /** The store's day the answer was built for (`store_day`). */
  storeDay: string;
}

export interface BellItemSpec {
  icon: BellIcon;
  /** One line, sentence case, says what is wrong. */
  title: (item: BellItem, ctx: BellContext) => string;
  /** One short line of specifics: the day, the amount. */
  detail: (item: BellItem, ctx: BellContext) => string;
  /** The page that fixes it. Checked with `canAccess` before the
   *  row is shown — no access, no control. */
  to: (item: BellItem, ctx: BellContext) => string;
}

/** "Yesterday" / "Today" against the store's day, else the weekday
 *  label ("Sat, Nov 1, 2026"). */
export function dayWords(day: string | null | undefined, storeDay: string): string {
  if (!day) return "";
  if (day === storeDay) return "Today";
  if (day === addDaysIso(storeDay, -1)) return "Yesterday";
  return formatDayLabel(day);
}

function money(cents: number | null | undefined): string {
  return fmtMoney2((cents ?? 0) / 100);
}

export const BELL_ITEMS: Record<BellKind, BellItemSpec> = {
  "daily_book.unlocked": {
    icon: "book",
    title: (i) => (i.count === 1
      ? "A daily book is not locked"
      : `${fmtCount(i.count, "daily book")} are not locked`),
    detail: (i, c) => (i.count === 1
      ? dayWords(i.day, c.storeDay)
      : `Oldest: ${dayWords(i.day, c.storeDay)}`),
    to: (i) => `/daily/edit?date=${i.day ?? ""}`,
  },
  "daily_book.due_back": {
    icon: "cash",
    title: (i) => (i.urgency === "overdue"
      ? "Money is past its back-by date"
      : "Money is due back today"),
    detail: (i, c) => `${fmtCount(i.count, "entry", "entries")} · ${money(i.amount_cents)}`
      + (i.urgency === "overdue" ? ` · since ${dayWords(i.day, c.storeDay)}` : ""),
    to: (_i, c) => `/daily/edit?date=${c.storeDay}`,
  },
  "bank.to_check": {
    icon: "bank",
    title: (i) => `${fmtCount(i.count, "bank transaction")} to check`,
    detail: (i) => (i.view === "review"
      ? "Not in the daily book yet"
      : "No category yet"),
    to: (i) => (i.view === "review"
      ? "/bank-transactions?books=review"
      : "/bank-transactions?uncategorized_only=1"),
  },
  "return_checks.pending": {
    icon: "check",
    title: (i) => `${fmtCount(i.count, "returned check")} pending over 30 days`,
    detail: (i, c) => `${money(i.amount_cents)} · oldest ${dayWords(i.day, c.storeDay)}`,
    to: () => "/return-checks?status=pending",
  },
};
