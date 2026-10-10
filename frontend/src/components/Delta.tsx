import { fmtDelta } from "../lib/formatters";
import styles from "./Delta.module.css";

/** A period-over-period change for a KPI tile's `sub` line:
 *  "▲ $1,234 vs prior" in the accent, "▼ …" in negative. Renders
 *  nothing when there is no number. */
export function Delta({
  value, money = false, suffix = "",
}: {
  value: number | null | undefined;
  money?: boolean;
  suffix?: string;
}) {
  if (value == null || !isFinite(value)) return null;
  return (
    <span className={value >= 0 ? styles.up : styles.down}>
      {fmtDelta(value, money ? "money" : "count")}{suffix}
    </span>
  );
}
