// Return-checks API hooks. Backed by /api/v2/return-checks.

import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import type { PillTone } from "../components/ui";
import type { components } from "./openapi";
import { t, type MessageKey } from "../i18n";

/** Return-check status → Pill tone (UI-STANDARDS §3). */
export const RETURN_CHECK_STATUS_TONES: Record<string, PillTone> = {
  pending:   "warning",
  recovered: "success",
  loss:      "negative",
  fraud:     "negative",
};

const RETURN_CHECK_STATUS_KEYS: Record<string, MessageKey> = {
  pending: "returnCheck.statusPending",
  recovered: "returnCheck.statusRecovered",
  loss: "returnCheck.statusLoss",
  fraud: "returnCheck.statusFraud",
};

/** A stored return-check status ("pending") in the person's
 *  language; an unknown value is shown as stored. */
export function returnCheckStatusLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return Object.hasOwn(RETURN_CHECK_STATUS_KEYS, value)
    ? t(RETURN_CHECK_STATUS_KEYS[value])
    : value;
}

/** How a customer paid back a returned check. Values are stored. */
export const RETURN_CHECK_PAYMENT_METHODS = [
  "cash", "check", "zelle", "wire", "money_order", "other",
] as const;

const PAYMENT_METHOD_KEYS: Record<string, MessageKey> = {
  cash: "returnCheck.methodCash",
  check: "returnCheck.methodCheck",
  zelle: "returnCheck.methodZelle",
  wire: "returnCheck.methodWire",
  money_order: "returnCheck.methodMoneyOrder",
  other: "returnCheck.methodOther",
};

/** A stored payment method ("money_order") in the person's language. */
export function paymentMethodLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return Object.hasOwn(PAYMENT_METHOD_KEYS, value) ? t(PAYMENT_METHOD_KEYS[value]) : value;
}

export type ReturnCheckRow = components["schemas"]["ReturnCheckRow"];

export interface ReturnCheckList {
  rows: ReturnCheckRow[];
  total: number;
  page: number;
  total_pages: number;
}

export interface ReturnCheckListQuery {
  status?: string; sort?: string; dir?: "asc" | "desc";
  page?: number; perPage?: number;
}

/** One page of the returned checks list — the request the list page
 *  and its CSV export both make. */
export function fetchReturnChecksPage({
  status = "", sort = "bounced", dir = "desc", page = 1, perPage = 50,
}: ReturnCheckListQuery = {}): Promise<ReturnCheckList> {
  const qs = new URLSearchParams({
    sort, dir, page: String(page), per_page: String(perPage),
  });
  if (status) qs.set("status", status);
  return api<ReturnCheckList>(`/api/v2/return-checks?${qs.toString()}`);
}

export function useReturnChecks(query: ReturnCheckListQuery = {}) {
  const identity = getCurrentIdentity();
  const {
    status = "", sort = "bounced", dir = "desc", page = 1, perPage = 50,
  } = query;
  return useQuery<ReturnCheckList>({
    enabled: identity?.store_id != null,
    queryKey: ["return-checks", "list", identity?.store_id, status, sort, dir, page, perPage],
    queryFn: () => fetchReturnChecksPage(query),
    placeholderData: (prev) => prev,
  });
}

export function useReturnCheck(rcId: number | undefined) {
  const identity = getCurrentIdentity();
  return useQuery<{ return_check: ReturnCheckRow }>({
    enabled:
      Number.isFinite(rcId) && identity?.store_id != null,
    queryKey: ["return-checks", "detail", identity?.store_id, rcId],
    queryFn: () =>
      api<{ return_check: ReturnCheckRow }>(
        `/api/v2/return-checks/${rcId}`,
      ),
  });
}

export interface ReturnCheckWriteBody {
  bounced_on: string;
  customer_name: string;
  company_name: string;
  check_number?: string;
  payer_bank?: string;
  amount: number;
  return_check_fee?: number;
  notes?: string;
}

export async function createReturnCheck(
  body: ReturnCheckWriteBody,
): Promise<{ return_check: ReturnCheckRow }> {
  return api<{ return_check: ReturnCheckRow }>(
    "/api/v2/return-checks",
    { method: "POST", json: body },
  );
}

export async function updateReturnCheck(
  rcId: number, body: ReturnCheckWriteBody,
): Promise<{ return_check: ReturnCheckRow }> {
  return api<{ return_check: ReturnCheckRow }>(
    `/api/v2/return-checks/${rcId}`,
    { method: "PUT", json: body },
  );
}

export async function markLoss(
  rcId: number,
): Promise<{ return_check: ReturnCheckRow }> {
  return api<{ return_check: ReturnCheckRow }>(
    `/api/v2/return-checks/${rcId}/mark-loss`,
    { method: "POST", json: {} },
  );
}

export async function markFraud(
  rcId: number,
): Promise<{ return_check: ReturnCheckRow }> {
  return api<{ return_check: ReturnCheckRow }>(
    `/api/v2/return-checks/${rcId}/mark-fraud`,
    { method: "POST", json: {} },
  );
}

export async function reopenReturnCheck(
  rcId: number,
): Promise<{ return_check: ReturnCheckRow }> {
  return api<{ return_check: ReturnCheckRow }>(
    `/api/v2/return-checks/${rcId}/reopen`,
    { method: "POST", json: {} },
  );
}

export type ReturnCheckPaymentRow = components["schemas"]["ReturnCheckPaymentRow"];

export function useReturnCheckPayments(rcId: number | undefined) {
  const identity = getCurrentIdentity();
  return useQuery<{ payments: ReturnCheckPaymentRow[] }>({
    enabled:
      Number.isFinite(rcId) && identity?.store_id != null,
    queryKey: ["return-checks", "payments", identity?.store_id, rcId],
    queryFn: () =>
      api<{ payments: ReturnCheckPaymentRow[] }>(
        `/api/v2/return-checks/${rcId}/payments`,
      ),
  });
}

export interface RecordPaymentBody {
  paid_on: string;       // YYYY-MM-DD
  amount: number;
  method?: string;       // cash / check / zelle / wire / money_order / other
  note?: string;
}

export interface PaymentMutationResponse {
  // ``null`` on DELETE; populated on POST.
  payment: ReturnCheckPaymentRow | null;
  return_check: ReturnCheckRow;
}

export async function createReturnCheckPayment(
  rcId: number, body: RecordPaymentBody,
): Promise<PaymentMutationResponse> {
  return api<PaymentMutationResponse>(
    `/api/v2/return-checks/${rcId}/payments`,
    { method: "POST", json: body },
  );
}

export async function deleteReturnCheckPayment(
  rcId: number, paymentId: number,
): Promise<PaymentMutationResponse> {
  return api<PaymentMutationResponse>(
    `/api/v2/return-checks/${rcId}/payments/${paymentId}`,
    { method: "DELETE" },
  );
}
