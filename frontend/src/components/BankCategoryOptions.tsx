import type { BankCategoryGroup } from "../api/bankSync";

// The <option> list for a bank-category picker, grouped the way
// the server groups it: what books a daily-book line, what feeds
// the month's P&L, and what is only a tag.
//
// Shared because there are two pickers over the same list — the
// "Then categorize as" field on the rule form and the per-row
// select on the transactions page — and they have to offer exactly
// the same thing. The list itself is never hard-coded here: it
// comes from GET /api/v2/bank/categories, which is also what the
// server validates against, and it carries the store's own names
// for its P&L lines.
export function BankCategoryOptions({
  groups,
}: {
  groups: BankCategoryGroup[] | undefined;
}) {
  return (
    <>
      {(groups ?? []).map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.slug} value={o.slug}>{o.label}</option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
