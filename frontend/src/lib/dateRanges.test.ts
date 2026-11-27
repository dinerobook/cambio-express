import { describe, expect, it } from "vitest";

import {
  matchingPreset, monthRange, presetRange, RANGE_PRESETS, wholeMonth,
} from "./dateRanges";

describe("date range presets", () => {
  const today = "2026-11-27";

  it("works out every preset from the store's day", () => {
    expect(presetRange("this_month", today)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(presetRange("last_month", today)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetRange("this_quarter", today)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(presetRange("last_quarter", today)).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(presetRange("this_year", today)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(presetRange("last_year", today)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(presetRange("last_30_days", today)).toEqual({ from: "2026-10-29", to: "2026-11-27" });
  });

  it("crosses the year in January", () => {
    expect(presetRange("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("last_quarter", "2026-02-01")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(presetRange("last_30_days", "2026-01-10")).toEqual({ from: "2025-12-12", to: "2026-01-10" });
  });

  it("knows February and leap years", () => {
    expect(presetRange("this_month", "2028-02-10").to).toBe("2028-02-29");
    expect(presetRange("this_month", "2026-02-10").to).toBe("2026-02-28");
  });

  it("names the preset a range is", () => {
    for (const p of RANGE_PRESETS) expect(matchingPreset(presetRange(p, today), today)).toBe(p);
    expect(matchingPreset({ from: "2026-11-02", to: "2026-11-05" }, today)).toBeNull();
  });

  it("tells a whole month from any other range", () => {
    expect(wholeMonth(monthRange(2026, 2))).toEqual({ year: 2026, month: 2 });
    expect(wholeMonth({ from: "2026-11-01", to: "2026-11-29" })).toBeNull();
    expect(wholeMonth({ from: "2026-10-01", to: "2026-11-30" })).toBeNull();
  });
});
