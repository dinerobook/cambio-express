import type { BellItem, BellKind } from "../api/bell";
import { addDaysIso, formatDayLabel } from "./datetime";
import { fmtMoney2, fmtNumber } from "./formatters";
import { t, type MessageKey } from "../i18n";

// The one table that turns a bell item from the server into words,
// an icon and a link. The server sends only a kind and its numbers
// (api/Modules/Notifications/Services/bell); everything a person
// reads lives here, through the translator (`t`, keys `bell.*` in
// src/i18n/en.ts and es.ts).
//
// `Record<BellKind, …>`: a kind added on the server without its row
// here fails `npm run build` (the kinds come from the generated
// OpenAPI types), and tests/Modules/Notifications/test_bell_registry.py
// fails too. Rules for a new row: UI-STANDARDS §11 "The bell".

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
 *  label ("Sat, Nov 1, 2026"), in the person's language. */
export function dayWords(day: string | null | undefined, storeDay: string): string {
  if (!day) return "";
  if (day === storeDay) return t("bell.today");
  if (day === addDaysIso(storeDay, -1)) return t("bell.yesterday");
  return formatDayLabel(day);
}

function money(cents: number | null | undefined): string {
  return fmtMoney2((cents ?? 0) / 100);
}

/** One of two keys by count, the number through `fmtNumber`. */
function counted(n: number, one: MessageKey, many: MessageKey): string {
  return n === 1 ? t(one) : t(many, { count: fmtNumber(n) });
}

export const BELL_ITEMS: Record<BellKind, BellItemSpec> = {
  "daily_book.unlocked": {
    icon: "book",
    title: (i) => counted(i.count, "bell.unlockedOne", "bell.unlockedMany"),
    detail: (i, c) => (i.count === 1
      ? dayWords(i.day, c.storeDay)
      : t("bell.unlockedOldest", { day: dayWords(i.day, c.storeDay) })),
    to: (i) => `/daily/edit?date=${i.day ?? ""}`,
  },
  "daily_book.due_back": {
    icon: "cash",
    title: (i) => t(i.urgency === "overdue"
      ? "bell.dueBackOverdue" : "bell.dueBackToday"),
    detail: (i, c) => [
      counted(i.count, "bell.entryOne", "bell.entryMany"),
      money(i.amount_cents),
      ...(i.urgency === "overdue"
        ? [t("bell.since", { day: dayWords(i.day, c.storeDay) })] : []),
    ].join(" · "),
    to: (_i, c) => `/daily/edit?date=${c.storeDay}`,
  },
  "bank.to_check": {
    icon: "bank",
    title: (i) => counted(i.count, "bell.bankOne", "bell.bankMany"),
    detail: (i) => t(i.view === "review"
      ? "bell.bankReview" : "bell.bankUncategorized"),
    to: (i) => (i.view === "review"
      ? "/bank-transactions?books=review"
      : "/bank-transactions?uncategorized_only=1"),
  },
  "return_checks.pending": {
    icon: "check",
    title: (i) => counted(i.count, "bell.checksOne", "bell.checksMany"),
    detail: (i, c) => [
      money(i.amount_cents),
      t("bell.checksOldest", { day: dayWords(i.day, c.storeDay) }),
    ].join(" · "),
    to: () => "/return-checks?status=pending",
  },
};
