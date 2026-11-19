import { useId, type CSSProperties, type ReactNode } from "react";

import { FieldContext } from "./fieldContext";

/** A form field: the label above its control, with optional help text
 *  and an error under it.
 *
 *      <Field label="Email" error={errors.email} hint="We never share this.">
 *        <Input type="email" {...register("email")} />
 *      </Field>
 *
 *  How it is built, and why (UI-STANDARDS §1 "Fields"):
 *
 *  - The `<label>` wraps the label text AND the control, so ANY child
 *    is labelled — a kit control, a picker, a raw element.
 *  - The hint and the error sit OUTSIDE that `<label>`. Inside it they
 *    became part of the control's accessible name ("Email We never
 *    share this. Required."), so a screen reader read them as the
 *    field's name. Outside it, the kit controls point at them with
 *    `aria-describedby` (fieldContext.ts) and they are read as the
 *    description, after the name.
 *  - `error` (or `highlight`) marks the field invalid: the label and
 *    the box turn red, the control says `aria-invalid`, and the error
 *    carries an icon so the state never rests on colour alone.
 *  - `required` draws the one required mark (a `*` after the label)
 *    and says `aria-required` on the control. Never type a `*` into a
 *    label: the mark and its meaning come from here.
 */
export function Field({
  label, highlight, error, hint, required, style, children,
}: {
  label: ReactNode;
  /** Tints the label and the box red without a message — the error
   *  is shown elsewhere (a summary, a row below). Implied by
   *  ``error``. */
  highlight?: boolean;
  /** Field-level error message, under the control in the negative
   *  colour. The server's ``field_errors`` envelope maps 1:1 to this
   *  prop. */
  error?: ReactNode;
  /** Small muted help text under the control (above the error when
   *  both show). */
  hint?: ReactNode;
  /** Shows the required mark after the label and tells assistive
   *  tech the field must be filled. Validation stays the form's job. */
  required?: boolean;
  /** Extra style on the field's box. Use for ``gridColumn: "1 / -1"``
   *  style overrides when a field spans the width of its grid. */
  style?: CSSProperties;
  children: ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const invalid = Boolean(error) || Boolean(highlight);
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const hasLabel = label !== "" && label != null;
  return (
    <div
      className={invalid ? "ds-field ds-field--invalid" : "ds-field"}
      style={style}
    >
      <label className="ds-field__main">
        {hasLabel && (
          <span className="ds-field__label">
            {label}
            {required && (
              <span className="ds-field__required" aria-hidden="true">*</span>
            )}
          </span>
        )}
        <FieldContext.Provider
          value={{ describedBy, invalid, required: Boolean(required) }}
        >
          {children}
        </FieldContext.Provider>
      </label>
      {hint && (
        <span id={hintId} className="ds-field__hint">{hint}</span>
      )}
      {error && (
        <span id={errorId} className="ds-field__error">
          <svg
            className="ds-field__error-icon"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="7.5" x2="12" y2="13" />
            <line x1="12" y1="16.5" x2="12.01" y2="16.5" />
          </svg>
          <span>{error}</span>
        </span>
      )}
    </div>
  );
}
