// The preset periods of the shared date range picker
// (`components/ui/DateRangePicker.tsx`, UI-STANDARDS §4 "Date
// ranges"). Pure calendar math on the store's today, so the Monthly
// P&L and any later page offer the same periods, worked out the
// same way. Days are `YYYY-MM-DD`, both ends included.

import { t } from "../i18n";
import { formatDate, toIsoDate } from "./datetime";

export interface IsoRange { from: string; to: string; }

export type RangePreset =
  | "this_month" | "last_month"
  | "this_quarter" | "last_quarter"
  | "this_year" | "last_year"
  | "last_30_days";

export const RANGE_PRESETS: readonly RangePreset[] = [
  "this_month", "last_month", "this_quarter", "last_quarter",
  "this_year", "last_year", "last_30_days",
];

function span(y: number, m0: number, months: number): IsoRange {
  return {
    from: toIsoDate(new Date(y, m0, 1)),
    to: toIsoDate(new Date(y, m0 + months, 0)),
  };
}

/** The days a preset covers, counted from `today` (`YYYY-MM-DD`,
 *  the store's day). "This …" periods run to their end, so the
 *  page shows the whole month / quarter / year the store is in. */
export function presetRange(preset: RangePreset, today: string): IsoRange {
  const [y, m, d] = today.split("-").map(Number);
  const m0 = m - 1;
  const q0 = Math.floor(m0 / 3) * 3;
  switch (preset) {
    case "this_month": return span(y, m0, 1);
    case "last_month": return span(y, m0 - 1, 1);
    case "this_quarter": return span(y, q0, 3);
    case "last_quarter": return span(y, q0 - 3, 3);
    case "this_year": return span(y, 0, 12);
    case "last_year": return span(y - 1, 0, 12);
    case "last_30_days":
      return { from: toIsoDate(new Date(y, m0, d - 29)), to: today };
  }
}

/** The preset a range is, if any (so the picker can mark it). */
export function matchingPreset(r: IsoRange, today: string): RangePreset | null {
  return RANGE_PRESETS.find((p) => {
    const x = presetRange(p, today);
    return x.from === r.from && x.to === r.to;
  }) ?? null;
}

/** The one calendar month a range is exactly, else null. */
export function wholeMonth(r: IsoRange): { year: number; month: number } | null {
  const [y, m, d] = r.from.split("-").map(Number);
  if (d !== 1) return null;
  return span(y, m - 1, 1).to === r.to ? { year: y, month: m } : null;
}

/** A month as a range. */
export function monthRange(year: number, month: number): IsoRange {
  return span(year, month - 1, 1);
}

/** "Nov 1, 2026 – Nov 30, 2026": a range in the shared date format
 *  (one day reads as that day). */
export function rangeLabel(r: IsoRange): string {
  return r.from === r.to
    ? formatDate(r.from)
    : t("range.label", { from: formatDate(r.from), to: formatDate(r.to) });
}
