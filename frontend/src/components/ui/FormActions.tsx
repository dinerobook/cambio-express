import type { CSSProperties, ReactNode } from "react";

import type { UnsavedGuard } from "../../lib/useUnsavedGuard";
import { ConfirmDialog } from "./Modal";
import { Pill } from "./Pill";

// The Save / Cancel button bar at the bottom of every form. Inline
// styles for this row were duplicated across ~20 route files
// (BatchForm, EditTransfer, NewTransfer, EditMonthly, …) with
// near-identical shape: flex row, gap, right-aligned, top border,
// some top margin.
//
// Use as the last child of a form (or anywhere a fixed action
// strip belongs):
//
//     const guard = useUnsavedGuard(isDirty && !busy);
//     <FormActions guard={guard}>
//       <Button tone="secondary" onClick={onCancel}>Cancel</Button>
//       <Button type="submit" busy={saving}>Save changes</Button>
//     </FormActions>
//
// With `guard` (lib/useUnsavedGuard.ts) the bar is the form's
// unsaved-changes standard (UI-STANDARDS "Unsaved changes"): while
// the form is dirty it shows the "Unsaved changes" pill and pins to
// the bottom of the window so Save stays in reach, and it renders the
// "Leave without saving?" prompt for the guard's `confirmLeave`.
//
// The "save" button conventionally goes LAST (right-most position)
// — match the rest of the SPA so muscle memory stays consistent.
export function FormActions({
  children, style, align = "end", guard, note, sticky = false,
}: {
  children: ReactNode;
  style?: CSSProperties;
  /** Where the buttons land. ``end`` (default) right-aligns the
   *  cluster; ``between`` spreads the leftmost button to the left
   *  edge (useful for "Delete … Save" forms where deletion is
   *  intentionally far from the primary action). */
  align?: "end" | "between";
  /** The form's unsaved-changes guard. */
  guard?: UnsavedGuard;
  /** Status text on the left while the form is clean (the pill
   *  replaces it while dirty). */
  note?: ReactNode;
  /** Pin to the bottom of the window even while clean — for long
   *  forms whose Save would otherwise scroll out of view. */
  sticky?: boolean;
}) {
  const dirty = guard?.dirty ?? false;
  const status = dirty
    ? <Pill tone="warning" dot>Unsaved changes</Pill>
    : note;
  const className = [
    "ds-form-actions",
    align === "between" ? "ds-form-actions--between" : "",
    sticky || dirty ? "ds-form-actions--sticky" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={className} style={style}>
      {status != null && status !== false && (
        <div
          key={dirty ? "dirty" : "clean"}
          className="ds-form-actions__status"
          role="status"
        >
          {status}
        </div>
      )}
      {children}
      {guard && <ConfirmDialog {...guard.dialogProps} />}
    </div>
  );
}
