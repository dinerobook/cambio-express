import type { ReactNode } from "react";

import { fmtMoney2 } from "../lib/formatters";
import { Button, InfoTip } from "./ui";
import styles from "./DayBookChrome.module.css";

// The frame both day books share (MSB daily book, store daily
// book): a sticky toolbar with the trail on the left, the day
// stepper dead centre and the over/short + lock on the right, and a
// sticky total header on top of each column. One copy, so the two
// books read as the same product (UI-STANDARDS §12).

/** The sticky top bar. `children` is the day stepper (ONE element):
 *  it is the middle track of three, so it never slides sideways when
 *  the right side grows or shrinks. */
export function DayToolbar({
  lead, children, trail,
}: {
  /** Left: the breadcrumb trail. */
  lead: ReactNode;
  /** Middle: the kit `PeriodStepper`. */
  children: ReactNode;
  /** Right: over/short, the saved / locked pill, the lock button. */
  trail: ReactNode;
}) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarLead}>{lead}</div>
      {children}
      <div className={styles.toolbarTrail}>{trail}</div>
    </div>
  );
}

/** The day's name between the stepper's chevrons. */
export function DayStepLabel({ children }: { children: ReactNode }) {
  return <span className={styles.stepDate}>{children}</span>;
}

/** Read-only Over/Short, shown in the toolbar. The operator never
 *  types it: it is worked out from the day's entries. Green when
 *  over or zero, red when short. */
export function OverShortReadout({
  label, tip, value, negative,
}: {
  label: string;
  /** What the number means, behind the (i). */
  tip: string;
  /** Dollars. */
  value: number;
  negative: boolean;
}) {
  return (
    <div className={styles.osReadout}>
      <span className={styles.osReadoutLabel}>
        {label}
        <InfoTip text={tip} />
      </span>
      <span
        className={styles.osReadoutValue}
        style={{
          color: negative
            ? "var(--db-negative)"
            : "var(--db-accent)",
        }}
      >
        {fmtMoney2(value)}
      </span>
    </div>
  );
}

/** Lock / Unlock for a day. Shown only to someone with the "Lock /
 *  unlock days" switch (`day_lock.update`); `perm` adds the book's
 *  own edit right where the server asks for both. */
export function LockButton({
  locked, busy, onToggle, lockLabel, unlockLabel, perm = "day_lock.update",
}: {
  locked: boolean;
  busy: boolean;
  onToggle: () => void;
  lockLabel: string;
  unlockLabel: string;
  perm?: string;
}) {
  return (
    <Button
      type="button"
      tone={locked ? "primary" : "danger"}
      size="md"
      busy={busy}
      disabled={busy}
      perm={perm}
      onClick={onToggle}
    >
      <span className={styles.lockBtnInner}>
        {locked ? <UnlockIcon /> : <LockIcon />}
        {locked ? unlockLabel : lockLabel}
      </span>
    </Button>
  );
}

const STRIPE: Record<ColumnTone, string> = {
  accent: "var(--db-accent)",
  negative: "var(--db-negative)",
  info: "var(--db-info)",
  neutral: "var(--db-border)",
};

export type ColumnTone = "accent" | "negative" | "info" | "neutral";

/** Sticky per-column summary header. Subtle, design-system-safe:
 *  dark surface, a single stripe on top, the total in mono. It pins
 *  to the top of its own column so the column body scrolls behind it
 *  instead of behind a detached page bar. `tone` picks the stripe;
 *  only `negative` also colours the total (money going out). */
export function ColumnHeader({
  label, value, tone, sub,
}: {
  label: string;
  /** Dollars. */
  value: number;
  tone: ColumnTone;
  sub?: string;
}) {
  const valueColor =
    tone === "negative" ? "var(--db-negative)" : "var(--db-text)";
  return (
    <div className={styles.colHeader} style={{ borderTopColor: STRIPE[tone] }}>
      <div className={styles.colHeaderRow}>
        <span className={styles.colHeaderLabel}>{label}</span>
        <span className={styles.colHeaderValue} style={{ color: valueColor }}>
          {fmtMoney2(value)}
        </span>
      </div>
      {sub && <div className={styles.colHeaderSub}>{sub}</div>}
    </div>
  );
}

// Inline stroke SVGs (design system: no emoji in controls;
// stroke-width 2, round caps, currentColor, fill none).
function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function UnlockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}
