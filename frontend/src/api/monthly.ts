// Monthly P&L API hooks. Backed by /api/v2/monthly.

import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { t, type MessageKey } from "../i18n";
import { en } from "../i18n/en";
import type { components } from "./openapi";

export type MonthlyRow = components["schemas"]["MonthlyRow"];

// ── The P&L's lines, in order ───────────────────────────────
//
// One list for the P&L page and the edit form. `label` is the
// FALLBACK: a store can rename most lines (/monthly/categories) and
// the server sends its names with the month. `editable` lines are
// the ones the PUT takes; the rest are always filled by the server.
// "Cash flow" lines are adjustments: the first three count in total
// expenses (legacy P&L convention), cash carry forward counts in
// neither total.

export type MonthlySection = "Income" | "Expenses" | "Cash flow";

export interface MonthlyLine {
  key: keyof MonthlyRow & string;
  /** The shipped name, as a key (`pl.line.<field>`). */
  label: MessageKey;
  section: MonthlySection;
  editable: boolean;
}

function line(
  key: MonthlyLine["key"], label: MessageKey, section: MonthlySection,
  editable = true,
): MonthlyLine {
  return { key, label, section, editable };
}

export const MONTHLY_LINES: MonthlyLine[] = [
  line("taxable_sales",          "pl.line.taxable_sales",          "Income"),
  line("non_taxable",            "pl.line.non_taxable",            "Income"),
  line("money_order_fees",       "pl.line.money_order_fees",       "Income", false),
  line("bill_payment_charge",    "pl.line.bill_payment_charge",    "Income"),
  line("phone_recargas",         "pl.line.phone_recargas",         "Income"),
  line("boost_mobile",           "pl.line.boost_mobile",           "Income"),
  line("check_cashing_fees",     "pl.line.check_cashing_fees",     "Income", false),
  line("return_check_hold_fees", "pl.line.return_check_hold_fees", "Income"),
  line("rebates_commissions",    "pl.line.rebates_commissions",  "Income"),
  line("mt_commission_in_bank",  "pl.line.mt_commission_in_bank", "Income"),
  line("other_income_1",         "pl.line.other_income_1",         "Income"),
  line("other_income_2",         "pl.line.other_income_2",         "Income"),
  line("other_income_3",         "pl.line.other_income_3",         "Income"),
  // An over is the store's money; a short (negative) takes it back.
  line("over_short",             "pl.line.over_short",           "Income"),

  line("cash_purchases",      "pl.line.cash_purchases",   "Expenses", false),
  line("check_purchases",     "pl.line.check_purchases",  "Expenses", false),
  line("cash_expenses",       "pl.line.cash_expenses",    "Expenses", false),
  line("check_expenses",      "pl.line.check_expenses",   "Expenses", false),
  line("cash_payroll",        "pl.line.cash_payroll",     "Expenses", false),
  line("check_payroll",       "pl.line.check_payroll",    "Expenses", false),
  line("bank_charges_total",  "pl.line.bank_charges_total",     "Expenses"),
  line("credit_card_fees",    "pl.line.credit_card_fees", "Expenses"),
  line("money_order_rent",    "pl.line.money_order_rent", "Expenses"),
  line("emaginenet_tech",     "pl.line.emaginenet_tech", "Expenses"),
  line("irs_payroll_tax",     "pl.line.irs_payroll_tax",  "Expenses"),
  line("texas_workforce",     "pl.line.texas_workforce",  "Expenses"),
  line("other_taxes",         "pl.line.other_taxes",      "Expenses"),
  line("accounting_charges",  "pl.line.accounting_charges", "Expenses"),
  line("return_check_gl",     "pl.line.return_check_gl", "Expenses", false),
  line("other_expense_1",     "pl.line.other_expense_1",  "Expenses"),
  line("other_expense_2",     "pl.line.other_expense_2",  "Expenses"),
  line("other_expense_3",     "pl.line.other_expense_3",  "Expenses"),
  line("other_expense_4",     "pl.line.other_expense_4",  "Expenses"),
  line("other_expense_5",     "pl.line.other_expense_5",  "Expenses"),

  line("borrowed_money_return", "pl.line.borrowed_money_return", "Cash flow"),
  line("profit_distributed",    "pl.line.profit_distributed",    "Cash flow"),
  line("cash_carry_forward",    "pl.line.cash_carry_forward",    "Cash flow"),
];

/** Where one line's figure comes from this month. */
export type MonthlyLineSource = "daily" | "bank" | "returns" | "typed";

export function monthlyLineSource(
  r: MonthlyRow, key: string,
): MonthlyLineSource {
  // `?? []`: a response cached from before the daily feed shipped
  // has no `daily_fed`.
  if ((r.bank_locked ?? []).includes(key)) return "bank";
  if ((r.daily_fed ?? []).includes(key)) return "daily";
  if (key === "return_check_gl") return "returns";
  return "typed";
}

export const MONTHLY_SOURCE_LABELS: Record<MonthlyLineSource, MessageKey> = {
  daily: "pl.source.daily",
  bank: "pl.source.bank",
  returns: "pl.source.returns",
  typed: "pl.source.typed",
};

/** Each half's heading, in the person's language. The section
 *  values themselves stay English: they are how lines are grouped. */
export const MONTHLY_SECTION_LABELS: Record<MonthlySection, MessageKey> = {
  Income: "pl.section.income",
  Expenses: "pl.section.expenses",
  "Cash flow": "pl.section.cashFlow",
};

const SHIPPED_NAMES: Partial<Record<string, MessageKey>> = Object.fromEntries(
  MONTHLY_LINES.map((l) => [l.key, l.label]),
);

/** A P&L line's name for the screen. The server sends the store's
 *  name for each line: a name the store typed is shown as typed; the
 *  name we ship (or none) is shown in the person's language. A field
 *  this list does not know keeps the server's text. */
export function monthlyLineName(field: string, serverLabel?: string): string {
  const key = SHIPPED_NAMES[field];
  if (!key) return serverLabel || field;
  if (serverLabel && serverLabel !== en[key]) return serverLabel;
  return t(key);
}

/** A month, plus the store's own name for each P&L line. The
 *  labels ride along with the month so the form never renders
 *  "Other expense 1" for a beat before a second request corrects
 *  it. `report` is null only when nothing feeds the month: no saved
 *  row, no daily book day, no bank or return-check activity. */
export interface MonthlyDetail {
  report: MonthlyRow | null;
  labels: Record<string, string>;
}

export function useMonthly(year: number | undefined, month: number | undefined) {
  const identity = getCurrentIdentity();
  const enabled =
    identity?.store_id != null &&
    Number.isFinite(year) &&
    Number.isFinite(month);
  return useQuery<MonthlyDetail>({
    enabled,
    queryKey: ["monthly", "report", identity?.store_id, year, month],
    queryFn: async () => {
      try {
        return await api<MonthlyDetail>(
          `/api/v2/monthly/${year}/${month}`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return { report: null, labels: {} };
        }
        throw err;
      }
    },
  });
}

export type MonthLogged = components["schemas"]["MonthLogged"];

export interface MonthlyUpdateBody {
  taxable_sales?: number;
  non_taxable?: number;
  bill_payment_charge?: number;
  phone_recargas?: number;
  boost_mobile?: number;
  return_check_hold_fees?: number;
  rebates_commissions?: number;
  mt_commission_in_bank?: number;
  other_income_1?: number;
  other_income_2?: number;
  other_income_3?: number;
  bank_charges_total?: number;
  credit_card_fees?: number;
  money_order_rent?: number;
  emaginenet_tech?: number;
  irs_payroll_tax?: number;
  texas_workforce?: number;
  other_taxes?: number;
  accounting_charges?: number;
  other_expense_1?: number;
  other_expense_2?: number;
  other_expense_3?: number;
  other_expense_4?: number;
  other_expense_5?: number;
  over_short?: number;
  borrowed_money_return?: number;
  profit_distributed?: number;
  cash_carry_forward?: number;
  notes?: string;
}

export async function updateMonthly(
  year: number, month: number, body: MonthlyUpdateBody,
): Promise<MonthlyDetail> {
  return api<MonthlyDetail>(
    `/api/v2/monthly/${year}/${month}`,
    { method: "PUT", json: body },
  );
}

// ── P&L line names ──────────────────────────────────────────
//
// The P&L's lines are fixed columns, so a store cannot add one.
// What it can do is name them — claim a blank slot as "Bank Fee",
// or rename a line it inherited from the money-transfer days.
// `field` is the column and never changes; `label` is what the
// operator reads.

export interface MonthlyLineLabel {
  field: string;
  label: string;
  /** The name we ship — what "Reset" gives back. */
  default_label: string;
  is_custom: boolean;
  section: Exclude<MonthlySection, "Cash flow">;
  /** A blank-by-design slot. Stays out of the bank-category
   *  picker until the store names it. */
  is_slot: boolean;
  /** Whether a bank rule or transaction can be tagged into it. */
  bank_taggable: boolean;
}

export function useMonthlyLabels() {
  const identity = getCurrentIdentity();
  return useQuery<{ lines: MonthlyLineLabel[] }>({
    enabled: identity?.store_id != null,
    queryKey: ["monthly", "labels", identity?.store_id],
    queryFn: () => api<{ lines: MonthlyLineLabel[] }>("/api/v2/monthly/labels"),
    staleTime: 60_000,
  });
}

/** Partial save: only the lines present are touched, and an empty
 *  string resets one to its shipped default. */
export async function updateMonthlyLabels(
  labels: Record<string, string>,
): Promise<{ lines: MonthlyLineLabel[] }> {
  return api<{ lines: MonthlyLineLabel[] }>(
    "/api/v2/monthly/labels",
    { method: "PUT", json: { labels } },
  );
}

export function useLoggedMonths() {
  const identity = getCurrentIdentity();
  return useQuery<{ months: MonthLogged[] }>({
    enabled: identity?.store_id != null,
    queryKey: ["monthly", "months", identity?.store_id],
    queryFn: () => api<{ months: MonthLogged[] }>(`/api/v2/monthly/months`),
    staleTime: 60_000,
  });
}
