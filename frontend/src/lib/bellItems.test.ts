import { describe, it, expect } from "vitest";

import type { BellItem, BellKind } from "../api/bell";
import { findAccess } from "./access";
import { BELL_ITEMS, dayWords } from "./bellItems";

const ctx = { storeDay: "2026-11-04" };

function item(kind: BellKind, extra: Partial<BellItem> = {}): BellItem {
  return {
    key: kind, kind, urgency: "due", count: 1, day: "2026-11-03",
    amount_cents: 12_345, view: null, ...extra,
  };
}

describe("dayWords", () => {
  it("reads today and yesterday against the STORE's day", () => {
    expect(dayWords("2026-11-04", "2026-11-04")).toBe("Today");
    expect(dayWords("2026-11-03", "2026-11-04")).toBe("Yesterday");
    expect(dayWords("2026-10-31", "2026-11-01")).toBe("Yesterday");
    expect(dayWords("2026-11-01", "2026-11-04")).toBe("Sun, Nov 1, 2026");
    expect(dayWords(null, "2026-11-04")).toBe("");
  });
});

describe("BELL_ITEMS", () => {
  const kinds = Object.keys(BELL_ITEMS) as BellKind[];

  it("every row links to a real, access-checked page", () => {
    for (const kind of kinds) {
      const to = BELL_ITEMS[kind].to(item(kind, { view: "review" }), ctx);
      expect(findAccess(to), `${kind} → ${to}`).toBeDefined();
    }
  });

  it("every title is sentence case and every row has words", () => {
    for (const kind of kinds) {
      for (const count of [1, 3]) {
        const it_ = item(kind, { count });
        const title = BELL_ITEMS[kind].title(it_, ctx);
        const detail = BELL_ITEMS[kind].detail(it_, ctx);
        expect(title.length, kind).toBeGreaterThan(0);
        expect(detail.length, kind).toBeGreaterThan(0);
        // Sentence case: no Capitalised word after the first.
        const later = title.split(" ").slice(1).filter((w) => /^[A-Z][a-z]/.test(w));
        expect(later, `${kind}: ${title}`).toEqual([]);
      }
    }
  });

  it("counts agree with their noun", () => {
    expect(BELL_ITEMS["daily_book.unlocked"].title(item("daily_book.unlocked", { count: 3 }), ctx))
      .toBe("3 daily books are not locked");
    expect(BELL_ITEMS["bank.to_check"].title(item("bank.to_check", { count: 1 }), ctx))
      .toBe("1 bank transaction to check");
    expect(BELL_ITEMS["daily_book.due_back"].detail(item("daily_book.due_back", { count: 1 }), ctx))
      .toBe("1 entry · $123.45");
  });

  it("due back today versus overdue", () => {
    const spec = BELL_ITEMS["daily_book.due_back"];
    expect(spec.title(item("daily_book.due_back"), ctx)).toBe("Money is due back today");
    expect(spec.title(item("daily_book.due_back", { urgency: "overdue" }), ctx))
      .toBe("Money is past its back-by date");
  });

  it("bank rows open the view the server counted", () => {
    const spec = BELL_ITEMS["bank.to_check"];
    expect(spec.to(item("bank.to_check", { view: "review" }), ctx))
      .toBe("/bank-transactions?books=review");
    expect(spec.to(item("bank.to_check", { view: "uncategorized" }), ctx))
      .toBe("/bank-transactions?uncategorized_only=1");
  });

  it("a grouped unlocked item points at its oldest day", () => {
    const spec = BELL_ITEMS["daily_book.unlocked"];
    const grouped = item("daily_book.unlocked", { count: 2, day: "2026-10-30" });
    expect(spec.to(grouped, ctx)).toBe("/daily/edit?date=2026-10-30");
    expect(spec.detail(grouped, ctx)).toBe("Oldest: Fri, Oct 30, 2026");
  });
});
