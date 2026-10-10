import type { ReactNode } from "react";

import { fontSize, space, tokens } from "./tokens";

export type KpiTone =
  | "neutral" | "positive" | "negative" | "warning" | "primary" | "neon" | "muted";

const kpiAccent: Record<KpiTone, string> = {
  neutral:  tokens.border,
  primary:  tokens.info,
  neon:     tokens.accent,
  positive: tokens.accent,
  warning:  tokens.warning,
  negative: tokens.negative,
  muted:    tokens.border,
};

/** The value's colour when `colorValue` is set. Neutral tones keep
 *  the body text colour — a grey figure would read as disabled. */
const kpiValueColor: Record<KpiTone, string> = {
  neutral:  tokens.text,
  primary:  tokens.info,
  neon:     tokens.accent,
  positive: tokens.accent,
  warning:  tokens.warning,
  negative: tokens.negative,
  muted:    tokens.text,
};

/** Single stat tile: label / value / sub. Top border accents by
 *  tone. Use mono on the value via the `.ds-kpi-value` class.
 *
 *  `colorValue` also paints the figure in the tone's colour — for a
 *  tile whose number IS the signal (net profit below zero, pending
 *  hours waiting on approval), not for every tile in a row.
 *
 *  The root carries `.ds-kpi-card` so a page with a print sheet can
 *  reset the tile for paper (inline styles otherwise win). */
export function KpiCard({
  label, value, sub, tone = "neutral", colorValue = false,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: KpiTone;
  colorValue?: boolean;
}) {
  return (
    <div
      className="ds-kpi-card"
      style={{
        background: tokens.surface2,
        border: `1px solid ${tokens.border}`,
        borderTop: `3px solid ${kpiAccent[tone]}`,
        borderRadius: "0.75rem",
        padding: `${space.md} ${space.lg}`,
      }}
    >
      <div
        style={{
          fontSize: fontSize.xs,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: tokens.textMuted,
        }}
      >
        {label}
      </div>
      <div
        className="ds-kpi-value"
        style={{
          fontFamily: tokens.fontMono,
          fontSize: fontSize.xl,
          fontWeight: 700,
          marginTop: space.sm,
          color: colorValue ? kpiValueColor[tone] : undefined,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: fontSize.sm,
            color: tokens.textMuted,
            marginTop: space.xs,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}


/** Auto-fit grid of ``<KpiCard>``s. */
export function KpiGrid({
  children, minWidth = "200px",
}: {
  children: ReactNode;
  /** Minimum tile width before wrapping. 200px default; smaller
   *  for dense tables of metrics. */
  minWidth?: string;
}) {
  return (
    <div
      className="ds-fade-in"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}, 1fr))`,
        gap: space.md,
      }}
    >
      {children}
    </div>
  );
}
