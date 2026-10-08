import { describe, expect, it } from "vitest";

import {
  MONTH_NAMES, MONTH_NAMES_SHORT, daysAgoIso, formatDate, monthStartIso,
  toIsoDate, todayIso,
} from "./datetime";
import { fmtMoney, fmtMoney2 } from "./formatters";

describe("formatDate", () => {
  it("renders a bare YYYY-MM-DD as that calendar day (no tz shift)", () => {
    // The C-3 regression this guards: parsing "2026-08-30" as UTC
    // midnight and converting to a US timezone displayed Aug 29.
    expect(formatDate("2026-08-30")).toContain("Aug");
    expect(formatDate("2026-08-30")).toContain("30");
    expect(formatDate("2026-01-01")).toContain("1");
    expect(formatDate("2026-01-01")).not.toContain("Dec");
  });

  it("formats a full timestamp as a date", () => {
    const out = formatDate("2026-05-09T17:42:00Z");
    expect(out).toContain("2026");
    expect(out).toContain("May");
  });

  it("handles empty and garbage input defensively", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });
});

describe("fmtMoney2", () => {
  it("keeps thousands separators (the toFixed(2) bypass lost them)", () => {
    expect(fmtMoney2(12345.67)).toBe("$12,345.67");
    expect(fmtMoney2(0)).toBe("$0.00");
    expect(fmtMoney2(null)).toBe("$0.00");
  });

  it("puts a negative sign before the dollar sign", () => {
    expect(fmtMoney2(-50.5)).toBe("-$50.50");
    expect(fmtMoney2(-1234.5)).toBe("-$1,234.50");
    expect(fmtMoney2(-0.001)).toBe("$0.00");
    expect(fmtMoney(-1234.4)).toBe("-$1,234");
    expect(fmtMoney(-0.4)).toBe("$0");
    expect(fmtMoney(1234.6)).toBe("$1,235");
  });
});

describe("local calendar-day helpers", () => {
  // 23:30 local on Oct 7. In any timezone west of UTC the UTC day is
  // already Oct 8 — the bug the old `toISOString().slice(0, 10)`
  // copies had. These helpers must name the LOCAL day.
  const lateEvening = new Date(2026, 9, 7, 23, 30);

  it("toIsoDate names the local day, zero-padded", () => {
    expect(toIsoDate(lateEvening)).toBe("2026-10-07");
    expect(toIsoDate(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
  });

  it("todayIso reads the local day of `now`", () => {
    expect(todayIso(lateEvening)).toBe("2026-10-07");
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("daysAgoIso steps back across a month and year boundary", () => {
    expect(daysAgoIso(0, lateEvening)).toBe("2026-10-07");
    expect(daysAgoIso(7, lateEvening)).toBe("2026-09-30");
    expect(daysAgoIso(6, new Date(2026, 0, 3, 22, 0))).toBe("2025-12-28");
  });

  it("daysAgoIso with a negative count looks ahead", () => {
    expect(daysAgoIso(-1, lateEvening)).toBe("2026-10-08");
  });

  it("does not mutate the `now` it is given", () => {
    const now = new Date(2026, 9, 7, 12, 0);
    daysAgoIso(30, now);
    expect(toIsoDate(now)).toBe("2026-10-07");
  });

  it("monthStartIso is the first of the local month", () => {
    expect(monthStartIso(lateEvening)).toBe("2026-10-01");
    expect(monthStartIso(new Date(2026, 0, 31, 23, 59))).toBe("2026-01-01");
  });
});

describe("MONTH_NAMES", () => {
  it("is January-first in both lengths, indexed by month - 1", () => {
    expect(MONTH_NAMES).toHaveLength(12);
    expect(MONTH_NAMES_SHORT).toHaveLength(12);
    expect(MONTH_NAMES[0]).toBe("January");
    expect(MONTH_NAMES[12 - 1]).toBe("December");
    expect(MONTH_NAMES_SHORT[10 - 1]).toBe("Oct");
    MONTH_NAMES.forEach((name, i) => {
      expect(name.startsWith(MONTH_NAMES_SHORT[i])).toBe(true);
    });
  });
});
