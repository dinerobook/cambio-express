import { createContext, useContext } from "react";

/** What a `<Field>` tells the control inside it.
 *
 *  The kit's controls (`Input`, `Select`, `Textarea`, `MoneyInput`,
 *  `Checkbox`) read it so the hint and the error under the box are
 *  read out with the control (`aria-describedby`), a flagged field is
 *  announced as invalid (`aria-invalid`) and a required one as
 *  required (`aria-required`) — without every caller wiring ids.
 *  Kept in its own module so `Field.tsx` exports components only
 *  (Vite fast refresh). */
export interface FieldControl {
  /** Space-separated ids of the hint and the error, if shown. */
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

export const FieldContext = createContext<FieldControl | null>(null);

/** The surrounding `<Field>`, or null outside one. */
export function useFieldControl(): FieldControl | null {
  return useContext(FieldContext);
}

/** The aria attributes a kit control adds from its `<Field>`. Anything
 *  the caller set itself wins; `aria-describedby` is merged so a
 *  caller's own description is kept. */
export function fieldAria(
  field: FieldControl | null,
  own: {
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
    "aria-required"?: boolean | "true" | "false";
  },
): {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
  "aria-required"?: boolean | "true" | "false";
} {
  const describedBy = [own["aria-describedby"], field?.describedBy]
    .filter(Boolean)
    .join(" ");
  return {
    "aria-describedby": describedBy || undefined,
    "aria-invalid": own["aria-invalid"] ?? (field?.invalid ? true : undefined),
    "aria-required": own["aria-required"] ?? (field?.required ? true : undefined),
  };
}
