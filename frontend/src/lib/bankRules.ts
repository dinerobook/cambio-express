// Pure helpers for bank rules: the rule form's value shape and its
// mapping to / from the API row, and the sentence a rule reads as
// on the rules page. Kept out of the component files so fast
// refresh stays happy and so they can be unit-tested.

import {
  MATCH_TYPE_OPTIONS,
  type BankRuleRow,
  type BankRuleWriteBody,
} from "../api/bankSync";
import { fmtMoney2 } from "./formatters";

export interface BankRuleFormValues {
  enabled: boolean;
  priority: number;
  desc_match_type: string;
  desc_match_value: string;
  /** "" = any sign. */
  sign_filter: string;
  /** Dollars; 0 = unbounded. */
  amount_min: number;
  amount_max: number;
  /** "" = any account. */
  account_filter_id: string;
  target_kind: string;
  auto_post: boolean;
  /** Days to shift the booked day from the bank's posting date. */
  post_date_offset_days: number;
  description: string;
  apply_to_existing: boolean;
}

/** The day-shift choices a rule offers. A rule fires on rows nobody
 *  has looked at yet, so it can only shift from the bank's date —
 *  an absolute day belongs on the transaction itself. */
export const POST_OFFSET_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: -3, label: "3 days before the bank's date" },
  { value: -2, label: "2 days before the bank's date" },
  { value: -1, label: "1 day before the bank's date" },
  { value: 0,  label: "The bank's own date" },
  { value: 1,  label: "1 day after the bank's date" },
  { value: 2,  label: "2 days after the bank's date" },
];

/** "1 day before the bank's date" etc., for the rules list. */
export function postOffsetLabel(days: number): string {
  const known = POST_OFFSET_OPTIONS.find((o) => o.value === days);
  if (known) return known.label;
  const n = Math.abs(days);
  return `${n} day${n === 1 ? "" : "s"} ${days < 0 ? "before" : "after"} the bank's date`;
}

export const EMPTY_RULE_FORM: BankRuleFormValues = {
  enabled: true,
  priority: 100,
  desc_match_type: "contains",
  desc_match_value: "",
  sign_filter: "",
  amount_min: 0,
  amount_max: 0,
  account_filter_id: "",
  target_kind: "",
  auto_post: true,
  post_date_offset_days: 0,
  description: "",
  apply_to_existing: true,
};

export function formValuesFromRule(r: BankRuleRow): BankRuleFormValues {
  return {
    enabled: r.enabled,
    priority: r.priority,
    desc_match_type: r.desc_match_type || "contains",
    desc_match_value: r.desc_match_value,
    sign_filter: r.sign_filter,
    amount_min: r.amount_min_cents != null ? r.amount_min_cents / 100 : 0,
    amount_max: r.amount_max_cents != null ? r.amount_max_cents / 100 : 0,
    account_filter_id: r.account_filter_id != null ? String(r.account_filter_id) : "",
    target_kind: r.target_kind,
    auto_post: r.auto_post,
    post_date_offset_days: r.post_date_offset_days ?? 0,
    description: r.description,
    apply_to_existing: false,
  };
}

export function bodyFromFormValues(v: BankRuleFormValues): BankRuleWriteBody {
  const hasDesc = v.desc_match_value.trim() !== "";
  return {
    enabled: v.enabled,
    priority: Number(v.priority) || 100,
    desc_match_type: hasDesc ? v.desc_match_type : "",
    desc_match_value: v.desc_match_value.trim(),
    sign_filter: v.sign_filter,
    amount_min_cents: v.amount_min > 0 ? Math.round(v.amount_min * 100) : null,
    amount_max_cents: v.amount_max > 0 ? Math.round(v.amount_max * 100) : null,
    account_filter_id: v.account_filter_id ? Number(v.account_filter_id) : null,
    target_kind: v.target_kind,
    auto_post: v.auto_post,
    post_date_offset_days: Number(v.post_date_offset_days) || 0,
    description: v.description.trim(),
    apply_to_existing: v.apply_to_existing,
  };
}

/** The conditions of a rule as chip groups: one group per
 *  condition, each group a run of tokens ("description", "contains",
 *  "REMOTE DEPOSIT"). */
export function conditionChips(r: BankRuleRow): string[][] {
  const out: string[][] = [];
  if (r.desc_match_type && r.desc_match_value) {
    const op = MATCH_TYPE_OPTIONS.find((o) => o.value === r.desc_match_type)?.label
      ?? r.desc_match_type;
    out.push(["description", op, `“${r.desc_match_value}”`]);
  }
  if (r.sign_filter === "credit") out.push(["money in"]);
  if (r.sign_filter === "debit") out.push(["money out"]);
  if (r.amount_min_cents != null && r.amount_max_cents != null) {
    out.push(["amount", "between", fmtMoney2(r.amount_min_cents / 100), "and", fmtMoney2(r.amount_max_cents / 100)]);
  } else if (r.amount_min_cents != null) {
    out.push(["amount", "at least", fmtMoney2(r.amount_min_cents / 100)]);
  } else if (r.amount_max_cents != null) {
    out.push(["amount", "at most", fmtMoney2(r.amount_max_cents / 100)]);
  }
  if (r.account_filter_id != null) {
    out.push(["account", "is", r.account_filter_label || `#${r.account_filter_id}`]);
  }
  if (out.length === 0) out.push(["any transaction"]);
  return out;
}

/** Plain-text form of the sentence — for search and confirm copy. */
export function ruleSentence(r: BankRuleRow, labels: Map<string, string>): string {
  const conds = conditionChips(r).map((c) => c.join(" ")).join(" and ");
  const target = labels.get(r.target_kind) ?? r.target_kind;
  return `${r.description ? r.description + ": " : ""}if ${conds} → ${target}`;
}
