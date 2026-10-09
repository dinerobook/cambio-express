import { fmtMoney2 } from "../../lib/formatters";

/** One part of a figure: a label and its amount. `open` marks money
 *  that is still outstanding and NOT in the figure's total (owed to
 *  the store, checks on hold): it renders outlined instead of filled. */
export interface BreakdownPart {
  label: string;
  amount: number;
  open?: boolean;
}

/** The stacked breakdown under a total — one small pill per part,
 *  same size as a status `<Pill>`, coloured by position (series 1-5,
 *  `--db-series-*`), so the parts read at a glance without opening
 *  anything. A part at zero fades but stays, so cards in a row keep
 *  the same shape. Colour is position, never status: status keeps to
 *  `<Pill>` tones. UI-STANDARDS.md "Breakdown pills". */
export function BreakdownPills({ parts }: { parts: BreakdownPart[] }) {
  if (parts.length === 0) return null;
  return (
    <span className="ds-breakdown">
      {parts.map((p, i) => (
        <span
          key={p.label}
          className="ds-breakdown__pill"
          data-series={(i % 5) + 1}
          data-zero={p.amount === 0 ? "" : undefined}
          data-open={p.open ? "" : undefined}
        >
          {p.label}
          <span className="ds-breakdown__amount">{fmtMoney2(p.amount)}</span>
        </span>
      ))}
    </span>
  );
}
