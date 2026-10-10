import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "./Button";
import styles from "./PeriodStepper.module.css";

export type PeriodUnit = "day" | "week" | "month";
export type PeriodStepperVariant = "arrows" | "labeled" | "chevrons";

/** Previous / [middle] / next — the control every period page uses
 *  to walk its day, week or month.
 *
 *  The caller owns the period (URL param, state) and supplies the
 *  middle: a label, a month <Select>, a <DateInput>, a "Today" link.
 *  The stepper owns the buttons and what assistive tech hears —
 *  "Previous month" / "Next day" come from `unit`, so an arrow glyph
 *  is never the accessible name. The date maths lives next door in
 *  lib/datetime (`shiftMonth`, `addDaysIso`, `mondayOfIso`).
 *
 *  Variants (pick the one the surrounding chrome already uses):
 *   - `arrows`   ← / → small secondary buttons, for page headers.
 *   - `labeled`  "← Previous week" / "Next week →", for a stepper
 *                that stands on its own in a card.
 *   - `chevrons` square chevron icons, for a dense sticky toolbar.
 *
 *  `arrowKeys` binds ← / → on the window. It ignores keys typed
 *  into a field (so the caret still moves inside inputs) and
 *  modifier combos (⌘← is the browser's), and honours the disabled
 *  bounds — the same rules a button press follows. */
export function PeriodStepper({
  unit, onPrev, onNext, children, prevDisabled, nextDisabled,
  onToday, todayLabel = "Today", onCalendar, variant = "arrows",
  arrowKeys = false, fill = false,
}: {
  unit: PeriodUnit;
  onPrev: () => void;
  onNext: () => void;
  /** Between the arrows: the period's label or a picker. */
  children?: ReactNode;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  /** Renders a jump-to-now button after the next arrow. */
  onToday?: () => void;
  todayLabel?: string;
  /** Renders a "Back to calendar" icon button at the end — a day
   *  page's way back up to its month. */
  onCalendar?: () => void;
  variant?: PeriodStepperVariant;
  arrowKeys?: boolean;
  /** Stretch across the container. Give the middle `flex: 1` to
   *  push the next / today buttons to the far edge. */
  fill?: boolean;
}) {
  const prevLabel = `Previous ${unit}`;
  const nextLabel = `Next ${unit}`;

  // The listener is bound once; the latest callbacks + bounds are
  // read through a ref so a re-render never re-binds it.
  const latest = useRef({ onPrev, onNext, prevDisabled, nextDisabled });
  useEffect(() => {
    latest.current = { onPrev, onNext, prevDisabled, nextDisabled };
  });
  useEffect(() => {
    if (!arrowKeys) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
          el?.isContentEditable) {
        return;
      }
      const cur = latest.current;
      if (e.key === "ArrowLeft") {
        if (!cur.prevDisabled) cur.onPrev();
      } else if (!cur.nextDisabled) {
        cur.onNext();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [arrowKeys]);

  const cls = [
    styles.stepper,
    variant === "chevrons" ? styles.dense : "",
    fill ? styles.fill : "",
  ].filter(Boolean).join(" ");

  const keyHint = (k: string) => (arrowKeys ? ` (${k})` : "");

  if (variant === "chevrons") {
    return (
      <div className={cls}>
        <button
          type="button" className={styles.iconBtn}
          onClick={onPrev} disabled={prevDisabled}
          aria-label={prevLabel} title={`${prevLabel}${keyHint("←")}`}
        >
          <ChevronLeftIcon />
        </button>
        {children}
        <button
          type="button" className={styles.iconBtn}
          onClick={onNext} disabled={nextDisabled}
          aria-label={nextLabel} title={`${nextLabel}${keyHint("→")}`}
        >
          <ChevronRightIcon />
        </button>
        {onToday && (
          <Button tone="secondary" size="sm" onClick={onToday}>
            {todayLabel}
          </Button>
        )}
        {onCalendar && <CalendarButton onClick={onCalendar} />}
      </div>
    );
  }

  const labeled = variant === "labeled";
  const size = labeled ? "md" : "sm";
  return (
    <div className={cls}>
      <Button
        tone="secondary" size={size}
        onClick={onPrev} disabled={prevDisabled}
        aria-label={prevLabel} title={arrowKeys ? `${prevLabel} (←)` : undefined}
      >
        {labeled ? `← ${prevLabel}` : "←"}
      </Button>
      {children}
      <Button
        tone="secondary" size={size}
        onClick={onNext} disabled={nextDisabled}
        aria-label={nextLabel} title={arrowKeys ? `${nextLabel} (→)` : undefined}
      >
        {labeled ? `${nextLabel} →` : "→"}
      </Button>
      {onToday && (
        <Button tone="secondary" size={size} onClick={onToday}>
          {todayLabel}
        </Button>
      )}
      {onCalendar && <CalendarButton onClick={onCalendar} />}
    </div>
  );
}

function CalendarButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button" className={`${styles.iconBtn} ${styles.calendarBtn}`}
      onClick={onClick}
      aria-label="Back to calendar" title="Back to calendar"
    >
      <CalendarIcon />
    </button>
  );
}

// Inline stroke SVGs (design system: no emoji in controls;
// stroke-width 2, round caps, currentColor, fill none).
function ChevronLeftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}
