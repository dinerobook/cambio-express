// "Make a rule from this transaction" — the prefill the rule form
// opens with when the operator starts from a row on the bank
// transactions page. Pure so it can be unit-tested.
//
// Bank descriptions carry per-occurrence noise: dates ("04/29"),
// reference numbers, card suffixes, trace ids. A rule built from the
// literal string would never fire again. We keep the words and drop
// anything that looks like a number, so "REMOTE DEPOSIT FEE 04/29"
// suggests `contains "REMOTE DEPOSIT FEE"` and "ACH DEBIT INTERMEX
// 8834412" suggests `contains "ACH DEBIT INTERMEX"`.

export interface RuleSuggestion {
  desc_match_type: "contains";
  desc_match_value: string;
  sign_filter: "credit" | "debit";
}

/** Strip digit runs, dates, and the punctuation left behind; collapse
 *  whitespace. Falls back to the trimmed original when nothing but
 *  digits remained (a description that IS a reference number). */
export function matchTextFromDescription(description: string): string {
  const raw = description.trim();
  const stripped = raw
    // Dates and times: 04/29, 2026-05-06, 10:15
    .replace(/\b\d{1,4}[/:.-]\d{1,2}([/:.-]\d{1,4})?\b/g, " ")
    // Anything with a digit in it: ref ids, card suffixes, amounts.
    .replace(/\S*\d\S*/g, " ")
    // Stray separators and trailing punctuation.
    .replace(/[#*|_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s\-–—:,.]+$/g, "");
  return stripped || raw;
}

export function suggestRuleFor(txn: {
  description: string;
  amount_cents: number;
}): RuleSuggestion {
  return {
    desc_match_type: "contains",
    desc_match_value: matchTextFromDescription(txn.description),
    sign_filter: txn.amount_cents >= 0 ? "credit" : "debit",
  };
}
