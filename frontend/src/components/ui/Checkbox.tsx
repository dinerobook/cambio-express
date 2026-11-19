import type { CSSProperties, ReactNode } from "react";

import { fieldAria, useFieldControl } from "./fieldContext";
import { tokens } from "./tokens";

/** Boolean control.  Visually styled to match the kit's
 *  surface / border tokens; behaviourally a plain native
 *  `<input type="checkbox">` so form-libraries (react-hook-form,
 *  uncontrolled forms) Just Work.
 *
 *  Pass children — they're rendered as the clickable label; the
 *  whole label-row is the hit target so the checkbox itself
 *  doesn't need pixel-perfect aim.  When the visible label lives
 *  elsewhere (a matrix cell, a table row whose text names the
 *  thing), omit children and pass `aria-label` instead — one of
 *  the two is required for screen readers.
 *
 *  For purely-decorative use ("show as checked, don't gate any
 *  state"), pair with `disabled` and an explicit `aria-readonly`.
 */
export function Checkbox({
  checked, defaultChecked, onChange, disabled, name, value,
  children, style,
  "aria-describedby": describedBy,
  "aria-label": ariaLabel,
}: {
  /** Controlled-mode `checked`.  Pair with `onChange` to update
   *  it.  Mutually exclusive with `defaultChecked`. */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  name?: string;
  value?: string;
  /** Visible label. Omit only when `aria-label` is provided. */
  children?: ReactNode;
  style?: CSSProperties;
  "aria-describedby"?: string;
  /** Accessible name for label-less use (matrix cells etc.). */
  "aria-label"?: string;
}) {
  // Inside a <Field> (a "Reconciled" column beside text boxes), the
  // box lines up with the inputs beside it (`.ds-field .ds-checkbox`
  // in ui.css) and is described by the Field's hint / error.
  const field = useFieldControl();
  // Stays a <label> inside a <Field> too: a Field may hold a group of
  // boxes, and only the box's own label sends a click on its text to
  // the right box (the Field's label would tick the first one).
  return (
    <label
      className="ds-checkbox"
      style={{
        display: "inline-flex",
        alignItems: "flex-start",
        gap: "0.55rem",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        ...style,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        defaultChecked={defaultChecked}
        onChange={(e) => onChange?.(e.target.checked)}
        disabled={disabled}
        name={name}
        value={value}
        aria-label={ariaLabel}
        {...fieldAria(field, { "aria-describedby": describedBy })}
        style={inputStyle}
      />
      {children != null && children !== "" && <span>{children}</span>}
    </label>
  );
}

// Native checkbox styled to match the design system.  Uses
// `accent-color` so the checked state takes the brand neon
// without us having to draw the checkmark ourselves.
const inputStyle: CSSProperties = {
  width: "1rem",
  height: "1rem",
  marginTop: "0.15rem",   // align with the first line of the label
  accentColor: tokens.accent,
  cursor: "inherit",
  flexShrink: 0,
};
