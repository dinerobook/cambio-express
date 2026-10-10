// Shared money + number formatting. Single source of truth so
// every table, KPI card, and detail row formats consistently.

/** Format a number as $X,XXX (no decimals). Good for KPI cards
 *  and summary stats where cents don't matter. */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "$0";
  // Sign before the "$": -$50, never $-50.
  const sign = Math.round(n) < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Format a number as $X,XXX.XX (2 decimals). Good for line items,
 *  transfer amounts, fees — anywhere cents matter. */
export function fmtMoney2(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "$0.00";
  // Sign before the "$": -$50.50, never $-50.50. A value that rounds
  // to zero cents shows as $0.00, not -$0.00.
  const sign = Math.round(n * 100) < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format a number as a locale-aware integer with commas. */
export function fmtNumber(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** A change since the prior period as "▲ $1,234" / "▼ 12": an arrow
 *  for the direction, then the size — through fmtMoney for money,
 *  fmtNumber for a count. Zero reads as "▲". Empty string when there
 *  is no number to show. Colour it with `<Delta>`. */
export function fmtDelta(
  delta: number | null | undefined,
  kind: "money" | "count" = "count",
): string {
  if (delta == null || !isFinite(delta)) return "";
  const arrow = delta >= 0 ? "▲" : "▼";
  const size = Math.abs(delta);
  return `${arrow} ${kind === "money" ? fmtMoney(size) : fmtNumber(size)}`;
}

/** Hours worked as "7.50" (two decimals, no unit). "—" when there is
 *  no figure yet (an open shift). */
export function fmtHours(h: number | null | undefined): string {
  if (h == null || !isFinite(h)) return "—";
  return h.toFixed(2);
}

// Date and time formatters live in lib/datetime.ts (store
// timezone, UTC parsing of API timestamps).
