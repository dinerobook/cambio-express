import type { ReactNode } from "react";

import { AppLink, Field, Select } from "./ui";
import { choicesWith } from "../lib/transferKinds";

/** A picker over one of the store's own lists from Settings → General
 *  (money transfer companies, transfer countries), shared by the new
 *  and edit transfer forms and the ACH batch form.
 *
 *  - `options` is the store's list (`useTransferChoices`). The field's
 *    current value is offered too when Settings has since dropped it,
 *    so editing a saved record never swaps its company or country.
 *  - While the list loads the select is disabled; an empty list says
 *    where to add one instead of leaving an empty dropdown.
 *  - Controlled (`value` / `onChange`), so the shown option always
 *    matches the form value even when the list arrives after it. */
export default function StoreListField({
  label, options, value, onChange, loading, emptyText, error,
}: {
  label: ReactNode;
  options: readonly string[] | undefined;
  value: string;
  onChange: (next: string) => void;
  loading?: boolean;
  /** Shown under an empty list, before the Settings link. */
  emptyText: string;
  error?: ReactNode;
}) {
  const list = choicesWith(options ?? [], value);
  const empty = !loading && list.length === 0;
  return (
    <Field
      label={label}
      error={error}
      hint={empty ? (
        <>
          {emptyText}{" "}
          <AppLink to="/settings/general" fallback="text">
            Settings → General
          </AppLink>
        </>
      ) : undefined}
    >
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading || empty}
      >
        {/* Only while nothing is picked yet (loading / empty list). */}
        {!value && <option value="">—</option>}
        {list.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
    </Field>
  );
}
