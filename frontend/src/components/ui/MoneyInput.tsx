import {
  useEffect, useId, useState,
  type CSSProperties, type ReactNode,
} from "react";

import { fieldAria, useFieldControl } from "./fieldContext";
import { tokens } from "./tokens";

/** Dollar / money input — kit primitive.
 *
 *  Replaces every `<Input type="number" step="0.01">` that
 *  accepted a dollar amount.  Why a dedicated primitive?
 *
 *  1. `type="number"` ships spinner arrows + scroll-to-increment
 *     behaviour that pilots hate on monetary fields (an
 *     accidental scroll on a mobile browser can change the
 *     amount).  `type="text"` + `inputMode="decimal"` shows the
 *     numeric keypad on mobile without any of the spinner UX.
 *  2. Empty input MUST mean 0 — not "0", not "0.00".  A zero
 *     pre-filled in the box reads as data the cashier already
 *     entered; an empty box reads as "nothing here yet".
 *  3. Dollar prefix is consistent across the SPA, declared once
 *     here.  Pass `prefix=""` to drop it (e.g. for percentages).
 *
 *  Behavioural contract:
 *   - `value === 0` → renders empty input (no "0" / "0.00").
 *   - Empty input + `onChange` fires `0`.
 *   - Non-numeric characters are stripped before they reach the
 *     `onChange` handler, so the parent never receives garbage.
 *   - Scroll-wheel does NOT change the value (we blur on wheel).
 *   - Hits the `<Field>` machinery for label / hint / error so
 *     the visual treatment matches the rest of the kit.
 *
 *  See `api/Modules/DailyBook/INVARIANTS.md` — dollar fields on
 *  the daily book all go through this primitive now.
 */
export function MoneyInput({
  value, onChange, label, hint, error,
  disabled, readOnly, required, prefix = "$", placeholder,
  align = "right", style, fullWidth = false, dense = false,
  "aria-label": ariaLabel,
}: {
  /** Current numeric value.  `0` renders as empty input. */
  value: number;
  onChange: (next: number) => void;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  readOnly?: boolean;
  /** Blocks form submit while the box is empty. Empty means 0, so a
   *  required money field is one that must be greater than zero. */
  required?: boolean;
  /** Prefix character.  Default `"$"`.  Pass `""` to drop the
   *  affix (e.g. for percentages, or for fields that already
   *  have a label that includes the currency). */
  prefix?: string;
  placeholder?: string;
  /** Text alignment inside the input.  Right-align by default
   *  since money is conventionally right-aligned for visual
   *  scanning of a column of amounts. */
  align?: "left" | "right";
  style?: CSSProperties;
  /** Stretch the input box to fill its container instead of hugging
   *  its ~20ch intrinsic width. Use inside dense grids / table cells
   *  (e.g. the money-transfer breakdown) so columns shrink to fit the
   *  available width instead of forcing a horizontal scroll. */
  fullWidth?: boolean;
  /** Tighter side padding for a box in a table cell (the daily book's
   *  money-transfer grid), so a narrow column still shows ~7 digits. */
  dense?: boolean;
  "aria-label"?: string;
}) {
  const id = useId();
  // Inside a <Field>, the Field owns the label, hint and error: this
  // renders only the box (a <label> inside the Field's <label> is
  // invalid HTML and doubled the accessible name), described by the
  // Field's hint / error and invalid with it (fieldContext.ts).
  const field = useFieldControl();
  const isErr = Boolean(error) || Boolean(field?.invalid);
  const ownHintId = hint && !error ? `${id}-hint` : undefined;
  const ownErrorId = error ? `${id}-error` : undefined;
  const aria = fieldAria(field, {
    "aria-describedby": [ownHintId, ownErrorId].filter(Boolean).join(" ") || undefined,
    "aria-invalid": isErr || undefined,
    "aria-required": required || undefined,
  });
  const bare = field != null && !label && !hint && !error;

  // Local draft string so the input can hold "1." mid-type without
  // the controlled-prop re-render snapping it back to "1".  Two
  // sync paths:
  //  1. User types       → onInput updates BOTH `draft` AND fires
  //                        `onChange(parsed)` to the parent.
  //  2. Parent resets    → useEffect below reformats `draft` from
  //                        the new `value`, but ONLY when the
  //                        numeric equivalents differ.  That way
  //                        typing "1.0" doesn't get clobbered to
  //                        "1" while you're still mid-edit.
  const [draft, setDraft] = useState(() => formatDisplay(value));

  // Parse the current draft and compare to the prop value.  If
  // they already match numerically, leave the draft alone (the
  // user's mid-type ".0" stays put).  Otherwise resync from the
  // canonical value.  This is the standard React "prop synced to
  // local state" pattern — necessary here because we need a
  // STRING draft separate from the NUMBER prop so the user can
  // type intermediate states (".", "12.", etc.).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync the prop-driven `value` into local draft state ONLY when they diverge numerically; the `setDraft(prev => ...)` form means we read the latest draft without listing it as a dep
    setDraft((prev) =>
      parseDraft(prev) === value ? prev : formatDisplay(value),
    );
  }, [value]);

  const box = (
      <span
        // `ds-money` draws the hover / keyboard-focus ring and the red
        // invalid edge on the box (ui.css): the inner input has no
        // border of its own, so without it a tabbed-to money field
        // showed no focus at all.
        className={[
          "ds-money",
          isErr ? "ds-money--invalid" : "",
          disabled ? "ds-money--disabled" : "",
        ].filter(Boolean).join(" ")}
        style={{
          display: fullWidth ? "flex" : "inline-flex",
          width: fullWidth ? "100%" : undefined,
          minWidth: 0,
          alignItems: "stretch",
          ...(bare ? style : undefined),
        }}
      >
        {prefix && (
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0 0.5rem 0 0.65rem",
              color: tokens.textMuted,
              fontFamily: tokens.fontMono,
              fontSize: "0.9rem",
              userSelect: "none",
              borderRight: `1px solid ${tokens.border}`,
              background: tokens.surface2,
            }}
          >
            {prefix}
          </span>
        )}
        <input
          id={id}
          type="text"
          inputMode="decimal"
          /* `autoComplete="off"` so iOS / Android won't suggest a
             contact's amount-shaped field. */
          autoComplete="off"
          value={draft}
          aria-label={ariaLabel}
          {...aria}
          placeholder={placeholder ?? (prefix ? "" : "0")}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          onChange={(e) => {
            const cleaned = sanitizeDecimal(e.target.value);
            setDraft(cleaned);
            onChange(parseDraft(cleaned));
          }}
          /* When the field loses focus, re-format the draft to the
             canonical display (e.g. "" → "" still, "12." → "12",
             "12.50" stays as "12.5").  Keeps the rendered value
             consistent with how value=12.5 would appear if we'd
             hydrated from the server. */
          onBlur={() => setDraft(formatDisplay(parseDraft(draft)))}
          /* Mouse-wheel on a focused number input scrolls the
             value — that's the worst-feeling part of `type=number`.
             We use `type=text` here so the wheel doesn't change
             anything, but blur on wheel just in case some browser
             still attaches the behaviour. */
          onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            color: tokens.text,
            padding: dense ? "0.6rem 0.45rem" : "0.6rem 0.85rem",
            fontFamily: tokens.fontMono,
            fontSize: "0.95rem",
            lineHeight: 1.25,
            textAlign: align,
          }}
        />
      </span>
  );
  if (bare) return box;
  return (
    <div
      className={isErr ? "ds-field ds-field--invalid" : "ds-field"}
      style={style}
    >
      <label htmlFor={id} className="ds-field__main">
        {label && <span className="ds-field__label">{label}</span>}
        {box}
      </label>
      {hint && !error && (
        <span id={ownHintId} className="ds-field__hint">{hint}</span>
      )}
      {error && (
        <span id={ownErrorId} className="ds-field__error">{error}</span>
      )}
    </div>
  );
}

/** Parse a sanitized draft string back to its numeric value.
 *  Empty / lone dot / NaN all collapse to 0. */
function parseDraft(draft: string): number {
  if (draft === "" || draft === ".") return 0;
  const n = Number(draft);
  return Number.isFinite(n) ? n : 0;
}

/** Map a numeric value to the string the input should display.
 *  Hand-written so the rules are explicit:
 *   - 0 / NaN / Infinity   → "" (empty box)
 *   - whole numbers        → "123"     (no .00)
 *   - non-whole numbers    → "123.45"  (toFixed-trimmed)
 *  Editing a non-whole value while typing still works because
 *  the display only re-derives on parent re-render, and the
 *  parent only changes after `onChange` parses the input. */
function formatDisplay(v: number): string {
  if (!v || !Number.isFinite(v)) return "";
  // toFixed(2) followed by trailing-zero trim keeps "12.5" as
  // "12.5" instead of forcing "12.50".  Avoids the toString
  // edge case where 0.1+0.2 renders 7 decimals.
  const fixed = v.toFixed(2);
  return fixed.replace(/\.?0+$/, "") || "0";
}

/** Strip everything except digits + the FIRST decimal point.
 *  Empty string sentinel means "this is zero" so the parent
 *  doesn't need a special-case sentinel.  Negative values are
 *  rejected — there are no negative amounts in the daily book
 *  (`over_short` can be negative but is handled in code, not
 *  the keyboard). */
function sanitizeDecimal(raw: string): string {
  const noJunk = raw.replace(/[^\d.]/g, "");
  // Collapse multiple dots to the first one only.
  const firstDot = noJunk.indexOf(".");
  if (firstDot < 0) return noJunk;
  return (
    noJunk.slice(0, firstDot + 1)
    + noJunk.slice(firstDot + 1).replace(/\./g, "")
  );
}
