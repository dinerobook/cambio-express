// Monthly P&L API hooks. Backed by /api/v2/monthly.

import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";

export interface MonthlyRow {
  id: number;
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
}

/** A month, plus the store's own name for each P&L line. The
 *  labels ride along with the month so the form never renders
 *  "Other expense 1" for a beat before a second request corrects
 *  it. `report` is null when the month has no row yet. */
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
