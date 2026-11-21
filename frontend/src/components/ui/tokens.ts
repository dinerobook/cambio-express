// Design-system tokens — colors, spacing, type, mono helpers.
//
// Kept in a separate file from the component module so Vite's fast
// refresh can hot-reload the components in `./index.tsx` without
// being blocked by the non-component exports.
//
// Add to this file when introducing a new design token (a value
// that's referenced from more than one component), or when you'd
// otherwise be tempted to inline a hex / px / rem value in a
// route file.

import type { CSSProperties } from "react";

// ── Color + font tokens (resolve to the --db-* CSS vars set in
//    static/design-tokens.css). Fallbacks for if those vars are
//    ever stripped. ────────────────────────────────────────────

export const tokens = {
  surface:        "var(--db-surface)",
  surface2:       "var(--db-surface-2)",
  surface3:       "var(--db-surface-3)",
  border:         "var(--db-border)",
  borderSubtle:   "var(--db-border-subtle)",
  borderStrong:   "var(--db-border-strong)",
  text:           "var(--db-text)",
  textMuted:      "var(--db-text-muted)",
  accent:         "var(--db-accent)",
  onAccent:       "var(--db-on-accent)",
  negative:       "var(--db-negative)",
  warning:        "var(--db-warning)",
  info:           "var(--db-info)",
  positive:       "var(--db-positive)",
  fontDisplay:    "var(--db-font-display)",
  fontBody:       "var(--db-font-body)",
  fontMono:       "var(--db-font-mono)",
} as const;

// Tone palette — shared by Alert, ErrorState, Pill, Field error
// surfaces.  Each tone resolves to three layered colors (background
// tint + border + foreground saturation) defined in
// `static/design-tokens.css`.  Adding a new tone means adding the
// three `--db-tone-<name>-{bg,border,fg}` tokens there + extending
// this map.
export const toneTokens = {
  error: {
    bg:     "var(--db-tone-error-bg)",
    border: "var(--db-tone-error-border)",
    fg:     "var(--db-tone-error-fg)",
  },
  warning: {
    bg:     "var(--db-tone-warning-bg)",
    border: "var(--db-tone-warning-border)",
    fg:     "var(--db-tone-warning-fg)",
  },
  success: {
    bg:     "var(--db-tone-success-bg)",
    border: "var(--db-tone-success-border)",
    fg:     "var(--db-tone-success-fg)",
  },
  info: {
    bg:     "var(--db-tone-info-bg)",
    border: "var(--db-tone-info-border)",
    fg:     "var(--db-tone-info-fg)",
  },
} as const;

export const monoStyle: CSSProperties = { fontFamily: tokens.fontMono };

// ── Spacing scale (4 / 8 / 12 / 16 / 24 / 32 / 48 rem-based) ─

export const space = {
  xs:    "0.25rem",
  sm:    "0.5rem",
  md:    "0.75rem",
  lg:    "1rem",
  xl:    "1.5rem",
  "2xl": "2rem",
  "3xl": "3rem",
} as const;

// ── Type scale ──────────────────────────────────────────────

export const fontSize = {
  xs:    "0.72rem",
  sm:    "0.82rem",
  base:  "0.95rem",
  lg:    "1.05rem",
  xl:    "1.25rem",
  "2xl": "1.5rem",
  "3xl": "2rem",
} as const;

// ── Input style block — shared by Input/Select/Textarea so
//    `style={inputStyle}` still works for anyone importing it
//    directly (e.g. legacy code we haven't migrated). ─────────

export const inputStyle: CSSProperties = {
  // Colours, border, radius, padding, font and line height live in
  // the `.ds-input` rule (ui.css), with its hover / focus / invalid /
  // disabled / read-only states: an inline border here beat every one
  // of those rules, so none of them ever showed. Only the sizing
  // stays inline. (Font size is in the class too: iOS Safari zooms
  // the page into a focused field under 16px, and the class lifts it
  // on phones where an inline size could not be overridden.)
  width: "100%",
  boxSizing: "border-box",
};

// ── Table cell styles ───────────────────────────────────────

export const thStyle: CSSProperties = {
  textAlign: "left",
  // More vertical padding so header rows don't sit right on top
  // of the first data row, and there's enough room for the bold
  // weight to breathe.
  padding: "0.75rem 0.9rem",
  borderBottom: `1px solid ${tokens.border}`,
  fontSize: fontSize.xs,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: tokens.textMuted,
  fontWeight: 600,
  background: tokens.surface,
  position: "sticky",
  top: 0,
  // Above the rows it pins over: a link in a cell is positioned
  // (`.ds-link`, for its underline) and painted over a header with
  // no stacking order of its own — a ticket number showed through
  // the header as the list scrolled.
  zIndex: 1,
};

export const tdStyle: CSSProperties = {
  padding: "0.7rem 0.9rem",
  borderBottom: `1px solid ${tokens.borderSubtle}`,
  fontSize: fontSize.sm,
};

// Right-aligned twins for numeric columns — several routes were
// re-deriving these with identical spreads (UI-STANDARDS §5).
export const thStyleRight: CSSProperties = {
  ...thStyle, textAlign: "right",
};
export const tdStyleRight: CSSProperties = {
  ...tdStyle, textAlign: "right",
};
