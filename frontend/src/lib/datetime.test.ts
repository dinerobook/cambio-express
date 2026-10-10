import { describe, expect, it } from "vitest";

import {
  MONTH_NAMES, MONTH_NAMES_SHORT, daysAgoIso, formatDate, formatDateCompact,
  formatDateTime, formatDayLabel, formatShortDate, formatTime, formatTimestamp,
  getDisplayTimezone, monthStartIso, parseTimestamp, setDisplayTimezone,
  storeNow, toIsoDate, todayIso, utcToZonedInput, zonedInputToUtcIso,
  WEEKDAY_NAMES_SHORT, daysInMonth, formatWeekRange, isoDate, mondayOfIso,
  monthRangeIso, shiftMonth, weekdayOfIso,
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


// ── Store timezone ────────────────────────────────────────────
//
// The server stores naive UTC and sends it with no offset. The bug
// the owner saw: an employee locked the daily book at 10:00 in
// Chicago and the app showed 3:00 PM, because `new Date(naive)`
// read the UTC wall clock as local time.

describe("parseTimestamp", () => {
  it("reads an offset-less API timestamp as UTC", () => {
    expect(parseTimestamp("2026-10-09T15:00:00")?.toISOString())
      .toBe("2026-10-09T15:00:00.000Z");
    // Python isoformat() microseconds, and a space separator.
    expect(parseTimestamp("2026-10-09T15:00:00.123456")?.toISOString())
      .toBe("2026-10-09T15:00:00.123Z");
    expect(parseTimestamp("2026-10-09 15:00")?.toISOString())
      .toBe("2026-10-09T15:00:00.000Z");
  });

  it("keeps an explicit offset", () => {
    expect(parseTimestamp("2026-10-09T15:00:00Z")?.toISOString())
      .toBe("2026-10-09T15:00:00.000Z");
    expect(parseTimestamp("2026-10-09T10:00:00-05:00")?.toISOString())
      .toBe("2026-10-09T15:00:00.000Z");
  });

  it("returns null for empty or garbage input", () => {
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp("not-a-date")).toBeNull();
  });
});

describe("display timezone", () => {
  it("renders the reported lock time on the store's clock", () => {
    setDisplayTimezone("America/Chicago");
    expect(formatDateTime("2026-10-09T15:00:00")).toBe("Oct 9, 10:00 AM");
    expect(formatTime("2026-10-09T15:00:00")).toBe("10:00 AM");
    expect(formatTimestamp("2026-10-09T15:00:00"))
      .toBe("Oct 9, 2026, 10:00 CDT");
  });

  it("follows a different store's zone", () => {
    setDisplayTimezone("America/Los_Angeles");
    expect(formatTime("2026-10-09T15:00:00")).toBe("8:00 AM");
    expect(formatTimestamp("2026-01-09T15:00:00"))
      .toBe("Jan 9, 2026, 07:00 PST");
  });

  it("dates a late-evening timestamp on the store's day, not UTC's", () => {
    setDisplayTimezone("America/New_York");
    // 02:30 UTC on Oct 10 is 22:30 on Oct 9 in New York.
    expect(formatDate("2026-10-10T02:30:00")).toBe("Oct 9, 2026");
    expect(formatShortDate("2026-10-10T02:30:00")).toBe("Oct 9");
    expect(formatDateCompact("2026-10-10T02:30:00")).toBe("10/09/26");
  });

  it("never shifts a bare calendar day", () => {
    setDisplayTimezone("Pacific/Honolulu");
    expect(formatDate("2026-10-09")).toBe("Oct 9, 2026");
    expect(formatShortDate("2026-10-09")).toBe("Oct 9");
    expect(formatDayLabel("2026-10-09")).toBe("Fri, Oct 9, 2026");
    expect(formatDateTime("2026-10-09")).toBe("Oct 9");
  });

  it("an explicit zone wins over the display zone", () => {
    setDisplayTimezone("America/Chicago");
    expect(formatTime("2026-10-09T15:00:00", { timeZone: "UTC" }))
      .toBe("3:00 PM");
  });

  it("ignores blank and unknown zones", () => {
    setDisplayTimezone("Not/AZone");
    expect(getDisplayTimezone()).toBeUndefined();
    setDisplayTimezone("  ");
    expect(getDisplayTimezone()).toBeUndefined();
    setDisplayTimezone("America/Chicago");
    expect(getDisplayTimezone()).toBe("America/Chicago");
    setDisplayTimezone(null);
    expect(getDisplayTimezone()).toBeUndefined();
  });

  it("remembers the zone on this device for the next load", () => {
    setDisplayTimezone("America/Denver");
    expect(localStorage.getItem("dinerobook.display_tz")).toBe("America/Denver");
    setDisplayTimezone("");
    expect(localStorage.getItem("dinerobook.display_tz")).toBeNull();
  });
});

describe("store-local today", () => {
  // 01:30 UTC on Oct 10 — still Oct 9 (evening) in every US zone.
  const utcAfterMidnight = new Date(Date.UTC(2026, 9, 10, 1, 30));

  it("todayIso is the store's day", () => {
    setDisplayTimezone("America/Chicago");
    expect(todayIso(utcAfterMidnight)).toBe("2026-10-09");
    setDisplayTimezone("Asia/Manila");
    expect(todayIso(utcAfterMidnight)).toBe("2026-10-10");
  });

  it("daysAgoIso and monthStartIso step from the store's day", () => {
    setDisplayTimezone("America/Chicago");
    expect(daysAgoIso(9, utcAfterMidnight)).toBe("2026-09-30");
    expect(daysAgoIso(-1, utcAfterMidnight)).toBe("2026-10-10");
    expect(monthStartIso(new Date(Date.UTC(2026, 10, 1, 3, 0))))
      .toBe("2026-10-01");
  });

  it("storeNow reads the store's wall clock in its local fields", () => {
    setDisplayTimezone("America/Chicago");
    const n = storeNow(utcAfterMidnight);
    expect([n.getFullYear(), n.getMonth() + 1, n.getDate(), n.getHours(), n.getMinutes()])
      .toEqual([2026, 10, 9, 20, 30]);
  });
});

describe("datetime-local inputs on the store clock", () => {
  it("round-trips a punch time without drifting", () => {
    setDisplayTimezone("America/Chicago");
    expect(utcToZonedInput("2026-10-09T15:00:00")).toBe("2026-10-09T10:00");
    expect(zonedInputToUtcIso("2026-10-09T10:00")).toBe("2026-10-09T15:00:00.000Z");
    // Saving the prefilled value unchanged keeps the same instant
    // (the old copy moved an edited punch by the UTC offset).
    expect(zonedInputToUtcIso(utcToZonedInput("2026-10-09T15:00:00")))
      .toBe("2026-10-09T15:00:00.000Z");
  });

  it("uses the right offset on each side of a DST change", () => {
    setDisplayTimezone("America/New_York");
    expect(zonedInputToUtcIso("2026-11-01T00:30")).toBe("2026-11-01T04:30:00.000Z");
    expect(zonedInputToUtcIso("2026-11-01T12:00")).toBe("2026-11-01T17:00:00.000Z");
  });

  it("returns blank for blank or malformed input", () => {
    expect(zonedInputToUtcIso("")).toBe("");
    expect(zonedInputToUtcIso("10:00")).toBe("");
    expect(utcToZonedInput("")).toBe("");
    expect(utcToZonedInput("garbage")).toBe("");
  });
});

describe("calendar periods", () => {
  it("shiftMonth steps a 1-12 month and rolls the year over", () => {
    expect(shiftMonth(2026, 10, 1)).toEqual({ year: 2026, month: 11 });
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 3, -14)).toEqual({ year: 2025, month: 1 });
    expect(shiftMonth(2026, 3, 0)).toEqual({ year: 2026, month: 3 });
  });

  it("daysInMonth knows short months and leap years", () => {
    expect(daysInMonth(2026, 10)).toBe(31);
    expect(daysInMonth(2026, 11)).toBe(30);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it("isoDate zero-pads and monthRangeIso spans the whole month", () => {
    expect(isoDate(2026, 1, 5)).toBe("2026-01-05");
    expect(monthRangeIso(2026, 10)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRangeIso(2028, 2)).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("weekdayOfIso reads the day of the week, Sunday = 0", () => {
    expect(weekdayOfIso("2026-10-11")).toBe(0); // Sunday
    expect(weekdayOfIso("2026-10-12")).toBe(1); // Monday
    expect(Number.isNaN(weekdayOfIso("nope"))).toBe(true);
    expect(WEEKDAY_NAMES_SHORT[weekdayOfIso("2026-10-10")]).toBe("Sat");
  });

  it("mondayOfIso walks back to Monday; a Sunday ends the prior week", () => {
    expect(mondayOfIso("2026-10-12")).toBe("2026-10-12");
    expect(mondayOfIso("2026-10-14")).toBe("2026-10-12");
    expect(mondayOfIso("2026-10-11")).toBe("2026-10-05");
    // Across a month and a year boundary.
    expect(mondayOfIso("2026-01-01")).toBe("2025-12-29");
    expect(mondayOfIso("bad")).toBe("bad");
  });

  it("formatWeekRange names the seven days and the start's year", () => {
    expect(formatWeekRange("2026-10-05")).toBe("Oct 5 – Oct 11, 2026");
    expect(formatWeekRange("2025-12-29")).toBe("Dec 29 – Jan 4, 2025");
  });
});
