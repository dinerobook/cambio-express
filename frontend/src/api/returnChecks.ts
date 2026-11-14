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
  /** Free-text search: customer, company, check #, bank, routing #. */
  q?: string;
  /** Only one batch's checks. */
  batchId?: number;
  /** Grouping keys from the By company / By customer lists. */
  company?: string;
  customer?: string;
}

/** One page of the returned checks list — the request the list page
 *  and its CSV export both make. */
export function fetchReturnChecksPage({
  status = "", sort = "bounced", dir = "desc", page = 1, perPage = 50,
  q = "", batchId, company = "", customer = "",
}: ReturnCheckListQuery = {}): Promise<ReturnCheckList> {
  const qs = new URLSearchParams({
    sort, dir, page: String(page), per_page: String(perPage),
  });
  if (status) qs.set("status", status);
  if (q) qs.set("q", q);
  if (batchId != null) qs.set("batch_id", String(batchId));
  if (company) qs.set("company", company);
  if (customer) qs.set("customer", customer);
  return api<ReturnCheckList>(`/api/v2/return-checks?${qs.toString()}`);
}

export function useReturnChecks(query: ReturnCheckListQuery = {}) {
  const identity = getCurrentIdentity();
  const {
    status = "", sort = "bounced", dir = "desc", page = 1, perPage = 50,
    q = "", batchId, company = "", customer = "",
  } = query;
  return useQuery<ReturnCheckList>({
    enabled: identity?.store_id != null,
    queryKey: [
      "return-checks", "list", identity?.store_id, status, sort, dir, page, perPage,
      q, batchId ?? null, company, customer,
    ],
    queryFn: () => fetchReturnChecksPage(query),
    placeholderData: (prev) => prev,
  });
}

// ── Batches ─────────────────────────────────────────────────

export type ReturnCheckBatchRow = components["schemas"]["ReturnCheckBatchRow"];
export type ReturnCheckBatchList = components["schemas"]["ReturnCheckBatchListResponse"];
export type ReturnCheckBatchDetail = components["schemas"]["ReturnCheckBatchResponse"];
export type ReturnCheckBatchCreateBody = components["schemas"]["ReturnCheckBatchCreateRequest"];
export type ReturnCheckBatchCheckBody = components["schemas"]["ReturnCheckBatchCheckRequest"];
export type ReturnCheckBatchUpdateBody = components["schemas"]["ReturnCheckBatchUpdateRequest"];

export interface ReturnCheckBatchListQuery {
  q?: string; sort?: string; dir?: "asc" | "desc"; page?: number; perPage?: number;
}

/** One page of returned batches — the list page and its CSV export. */
export function fetchReturnCheckBatchesPage({
  q = "", sort = "returned", dir = "desc", page = 1, perPage = 50,
}: ReturnCheckBatchListQuery = {}): Promise<ReturnCheckBatchList> {
  const qs = new URLSearchParams({
    sort, dir, page: String(page), per_page: String(perPage),
  });
  if (q) qs.set("q", q);
  return api<ReturnCheckBatchList>(`/api/v2/return-checks/batches?${qs.toString()}`);
}

export function useReturnCheckBatches(query: ReturnCheckBatchListQuery = {}) {
  const identity = getCurrentIdentity();
  const { q = "", sort = "returned", dir = "desc", page = 1, perPage = 50 } = query;
  return useQuery<ReturnCheckBatchList>({
    enabled: identity?.store_id != null,
    queryKey: ["return-checks", "batches", identity?.store_id, q, sort, dir, page, perPage],
    queryFn: () => fetchReturnCheckBatchesPage(query),
    placeholderData: (prev) => prev,
  });
}

export function useReturnCheckBatch(batchId: number | undefined) {
  const identity = getCurrentIdentity();
  return useQuery<ReturnCheckBatchDetail>({
    enabled: Number.isFinite(batchId) && identity?.store_id != null,
    queryKey: ["return-checks", "batch", identity?.store_id, batchId],
    queryFn: () => api<ReturnCheckBatchDetail>(`/api/v2/return-checks/batches/${batchId}`),
  });
}

export function createReturnCheckBatch(
  body: ReturnCheckBatchCreateBody,
): Promise<ReturnCheckBatchDetail> {
  return api<ReturnCheckBatchDetail>("/api/v2/return-checks/batches", {
    method: "POST", json: body,
  });
}

export function updateReturnCheckBatch(
  batchId: number, body: ReturnCheckBatchUpdateBody,
): Promise<ReturnCheckBatchDetail> {
  return api<ReturnCheckBatchDetail>(`/api/v2/return-checks/batches/${batchId}`, {
    method: "PUT", json: body,
  });
}

export function deleteReturnCheckBatch(batchId: number): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/api/v2/return-checks/batches/${batchId}`, {
    method: "DELETE",
  });
}

/** "May 3, 2026 · RTN-77" — how a batch is named in pickers and
 *  trails: its returned date, then the bank reference when there is one. */
export function batchName(
  batch: { returned_on: string; reference?: string | null },
  formatDay: (iso: string) => string,
): string {
  const ref = (batch.reference ?? "").trim();
  const day = formatDay(batch.returned_on);
  return ref ? `${day} · ${ref}` : day;
}

// ── Tracking by company / customer ──────────────────────────

export type ReturnCheckPartyRow = components["schemas"]["ReturnCheckPartyRow"];
export type ReturnCheckPartyList = components["schemas"]["ReturnCheckPartyListResponse"];
export type PartyKind = "company" | "customer";

export interface ReturnCheckPartyQuery {
  by: PartyKind; q?: string; from?: string; to?: string;
  sort?: string; dir?: "asc" | "desc"; page?: number; perPage?: number;
}

/** One page of the By company / By customer list. */
export function fetchReturnCheckPartiesPage({
  by, q = "", from = "", to = "", sort = "checks", dir = "desc", page = 1, perPage = 50,
}: ReturnCheckPartyQuery): Promise<ReturnCheckPartyList> {
  const qs = new URLSearchParams({
    by, sort, dir, page: String(page), per_page: String(perPage),
  });
  if (q) qs.set("q", q);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  return api<ReturnCheckPartyList>(`/api/v2/return-checks/tracking?${qs.toString()}`);
}

export function useReturnCheckParties(query: ReturnCheckPartyQuery, enabled = true) {
  const identity = getCurrentIdentity();
  const {
    by, q = "", from = "", to = "", sort = "checks", dir = "desc", page = 1, perPage = 50,
  } = query;
  return useQuery<ReturnCheckPartyList>({
    enabled: enabled && identity?.store_id != null,
    queryKey: ["return-checks", "tracking", identity?.store_id, by, q, from, to, sort, dir, page, perPage],
    queryFn: () => fetchReturnCheckPartiesPage(query),
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
  /** null = not in a batch. Left out, the check keeps its batch. */
  batch_id?: number | null;
  routing_number?: string;
  account_number?: string;
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
