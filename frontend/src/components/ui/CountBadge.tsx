import styles from "./CountBadge.module.css";

/** Phone-style "needs attention" circle with a count — the Support
 *  button's unread replies, the top-bar bell's open items. The one
 *  count badge in the app (UI-STANDARDS §6).
 *
 *  - Hidden at 0, so the control it sits on never changes size.
 *  - Caps at `max` ("99+", "9+") so the circle never stretches.
 *  - Pinned to the top-right corner of its positioned parent; give
 *    the parent `position: relative`. `inline` renders it in the row
 *    flow instead (the phone drawer's rows).
 *  - `aria-hidden`: the control's own label carries the count, so a
 *    screen reader hears it once, in words. */
export function CountBadge({
  count, max = 99, inline = false,
}: {
  count: number;
  max?: number;
  inline?: boolean;
}) {
  if (!(count > 0)) return null;
  return (
    <span
      className={inline ? styles.inline : styles.pinned}
      aria-hidden="true"
      data-testid="count-badge"
    >
      {count > max ? `${max}+` : count}
    </span>
  );
}
