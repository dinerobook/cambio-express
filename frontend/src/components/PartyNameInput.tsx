import { useId } from "react";

import { useReturnCheckParties, type PartyKind } from "../api/returnChecks";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { Input } from "./ui";

/** A company or customer name on a returned check, suggesting the
 *  names this store already used (the By company / By customer
 *  lists, most returns first) so the same party is typed the same
 *  way every time and its returns add up. A native `<datalist>`:
 *  the browser draws the list, so it is never clipped by a card, and
 *  typing a new name is always allowed. Shared by the single check
 *  form and the New batch form. */
export function PartyNameInput({
  by, value, onChange, required, ariaLabel,
}: {
  by: PartyKind;
  value: string;
  onChange: (name: string) => void;
  required?: boolean;
  /** For an input without a visible `<Field>` label (batch rows). */
  ariaLabel?: string;
}) {
  const listId = useId();
  const typed = useDebouncedValue(value.trim());
  const { data } = useReturnCheckParties(
    { by, q: typed, perPage: 8 },
    typed.length >= 2,
  );
  // Don't offer the exact name already in the box.
  const names = (data?.rows ?? [])
    .map((r) => r.name)
    .filter((n) => n && n !== value);
  return (
    <>
      <Input
        type="text" required={required} maxLength={120}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        autoComplete="off"
        aria-label={ariaLabel}
      />
      <datalist id={listId}>
        {names.map((n) => <option key={n} value={n} />)}
      </datalist>
    </>
  );
}
