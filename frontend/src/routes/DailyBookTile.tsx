// The one box of the MSB daily book and the one tab strip inside it.
// Every box on the day view is a <DailyBookTile>: name, status pills
// beside the name, the total, and the stacked <BreakdownPills> — so
// the parts read without opening the box. Every box that holds more
// than one kind of thing opens to <BoxTabs> ("Part · $amount", plus
// the (i) tip for the active tab). UI-STANDARDS.md "Daily book boxes".

import type { ReactNode } from "react";

import { fmtMoney2 } from "../lib/formatters";
import {
  BreakdownPills, InfoTip, Pill, TabsBar, TabsButton,
  type BreakdownPart,
} from "../components/ui";
import styles from "./EditDailyBook.module.css";

export function DailyBookTile({
  title, total, parts, status, onOpen,
}: {
  title: string;
  total: number;
  parts: BreakdownPart[];
  /** Status pills (Auto, N open, N overdue) — shown beside the name. */
  status?: ReactNode;
  onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} className={styles.widgetCard}>
      <span className={styles.widgetCardTop}>
        <span className={styles.widgetLabel}>
          {title}
          {status}
        </span>
        <span className={styles.widgetTotal}>{fmtMoney2(total)}</span>
      </span>
      <BreakdownPills parts={parts} />
    </button>
  );
}

/** The one status pill for money still open on a box: red "N overdue"
 *  when any is overdue, else amber "N <openLabel>", else nothing. */
export function OpenStatusPill({
  open, overdue, openLabel = "open",
}: {
  open: number;
  overdue: number;
  openLabel?: string;
}) {
  if (overdue > 0) return <Pill tone="negative">{overdue} overdue</Pill>;
  if (open > 0) return <Pill tone="warning">{open} {openLabel}</Pill>;
  return null;
}

export interface BoxTab<K extends string> {
  key: K;
  label: string;
  amount: number;
  /** A status pill on the tab itself (e.g. "1 overdue"). */
  status?: ReactNode;
}

export function BoxTabs<K extends string>({
  tabs, active, onChange, tip, tipLabel,
}: {
  tabs: ReadonlyArray<BoxTab<K>>;
  active: K;
  onChange: (key: K) => void;
  /** Explains the ACTIVE tab, so it sits beside the strip. */
  tip?: string;
  tipLabel?: string;
}) {
  return (
    <div className={styles.tabsTipRow}>
      <TabsBar>
        {tabs.map((t) => (
          <TabsButton
            key={t.key}
            active={active === t.key}
            onClick={() => onChange(t.key)}
          >
            {t.label} · {fmtMoney2(t.amount)}
            {t.status && <>{" "}{t.status}</>}
          </TabsButton>
        ))}
      </TabsBar>
      {tip && <InfoTip text={tip} label={tipLabel} />}
    </div>
  );
}
