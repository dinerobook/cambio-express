// Monthly P&L API hooks. Backed by /api/v2/monthly.

import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";

export interface MonthlyRow {
  /** Null until someone saves the month (`saved` is false): the
   *  figures are still live from the daily books and bank feed. */
  id: number | null;
  store_id: number;
  year: number;
  month: number;
  taxable_sales: number;
  non_taxable: number;
  bill_payment_charge: number;
  phone_recargas: number;
  boost_mobile: number;
  check_cashing_fees: number;
  return_check_hold_fees: number;
  rebates_commissions: number;
  mt_commission_in_bank: number;
  other_income_1: number;
  other_income_2: number;
  other_income_3: number;
  /** Daily-book income with no stored column — read-only. */
  money_order_fees: number;
  cash_purchases: number;
  check_purchases: number;
  cash_expenses: number;
  check_expenses: number;
  cash_payroll: number;
  check_payroll: number;
  bank_charges_total: number;
  credit_card_fees: number;
  money_order_rent: number;
  emaginenet_tech: number;
  irs_payroll_tax: number;
  texas_workforce: number;
  other_taxes: number;
  accounting_charges: number;
  return_check_gl: number;
  other_expense_1: number;
  other_expense_2: number;
  other_expense_3: number;
  other_expense_4: number;
  other_expense_5: number;
  over_short: number;
  borrowed_money_return: number;
  profit_distributed: number;
  cash_carry_forward: number;
  notes: string;
  total_income: number;
  total_expenses: number;
  net_profit: number;
  /** Columns the bank feed fills this month — rendered read-only,
   *  ignored by the server on save. */
  bank_locked: string[];
  /** Every line whose figure comes from the daily books this month
   *  (and not the bank) — read-only, "From daily book". */
  daily_fed: string[];
  /** Distinct days entered in either daily book this month. */
  days_entered: number;
  /** Money orders counted this month, and what the companies charge
   *  for them — already taken off `money_order_fees`. */
  money_order_count: number;
  money_order_charges: number;
  /** False until someone saves the month. */
  saved: boolean;
}

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
  label: string;
  section: MonthlySection;
  editable: boolean;
}

function line(
  key: MonthlyLine["key"], label: string, section: MonthlySection,
  editable = true,
): MonthlyLine {
  return { key, label, section, editable };
}

export const MONTHLY_LINES: MonthlyLine[] = [
  line("taxable_sales",          "Taxable sales",          "Income"),
  line("non_taxable",            "Non-taxable",            "Income"),
  line("money_order_fees",       "Money order fees",       "Income", false),
  line("bill_payment_charge",    "Bill payment charge",    "Income"),
  line("phone_recargas",         "Phone recargas",         "Income"),
  line("boost_mobile",           "Boost Mobile",           "Income"),
  line("check_cashing_fees",     "Check cashing fees",     "Income", false),
  line("return_check_hold_fees", "Return check hold fees", "Income"),
  line("rebates_commissions",    "Rebates / commissions",  "Income"),
  line("mt_commission_in_bank",  "Money transfer commission in bank", "Income"),
  line("other_income_1",         "Other income 1",         "Income"),
  line("other_income_2",         "Other income 2",         "Income"),
  line("other_income_3",         "Other income 3",         "Income"),
  // An over is the store's money; a short (negative) takes it back.
  line("over_short",             "Over / short",           "Income"),

  line("cash_purchases",      "Cash purchases",   "Expenses", false),
  line("check_purchases",     "Check purchases",  "Expenses", false),
  line("cash_expenses",       "Cash expenses",    "Expenses", false),
  line("check_expenses",      "Check expenses",   "Expenses", false),
  line("cash_payroll",        "Cash payroll",     "Expenses", false),
  line("check_payroll",       "Check payroll",    "Expenses", false),
  line("bank_charges_total",  "Bank charges",     "Expenses"),
  line("credit_card_fees",    "Credit card fees", "Expenses"),
  line("money_order_rent",    "Money order rent", "Expenses"),
  line("emaginenet_tech",     "EmagineNet / tech", "Expenses"),
  line("irs_payroll_tax",     "IRS payroll tax",  "Expenses"),
  line("texas_workforce",     "Texas workforce",  "Expenses"),
  line("other_taxes",         "Other taxes",      "Expenses"),
  line("accounting_charges",  "Accounting charges", "Expenses"),
  line("return_check_gl",     "Returned check gain/loss", "Expenses", false),
  line("other_expense_1",     "Other expense 1",  "Expenses"),
  line("other_expense_2",     "Other expense 2",  "Expenses"),
  line("other_expense_3",     "Other expense 3",  "Expenses"),
  line("other_expense_4",     "Other expense 4",  "Expenses"),
  line("other_expense_5",     "Other expense 5",  "Expenses"),

  line("borrowed_money_return", "Borrowed money return", "Cash flow"),
  line("profit_distributed",    "Profit distributed",    "Cash flow"),
  line("cash_carry_forward",    "Cash carry forward",    "Cash flow"),
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

export const MONTHLY_SOURCE_LABELS: Record<MonthlyLineSource, string> = {
  daily: "Daily book",
  bank: "Bank",
  returns: "Return checks",
  typed: "Typed",
};

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

export interface MonthLogged {
  year: number;
  month: number;
}

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
  section: "Income" | "Expenses";
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
