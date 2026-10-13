// Transfers API hooks. Wraps the existing FastAPI controllers
// at /api/v2/transfers with typed return shapes + TanStack Query
// caching. Each hook is auth-gated: callers must already be
// inside a <RequireAuth> subtree, which guarantees a JWT is in
// localStorage and the api() wrapper attaches it as Bearer.

import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import type { PillTone } from "../components/ui";
import type { components } from "./openapi";
import { PAYOUT_SERVICE, type PaymentMethod } from "../lib/transferKinds";

/** Transfer status → Pill tone (UI-STANDARDS §3). "Sent" is the
 *  completed happy path, so it reads as success, not live accent. */
export const TRANSFER_STATUS_TONES: Record<string, PillTone> = {
  Sent:      "success",
  Pending:   "warning",
  Cancelled: "negative",
  Returned:  "negative",
};

export interface TransferRow {
  id: number;
  send_date: string;
  company: string;
  service_type: string;
  /** "cash" or "debit_card" (paid on the company's card terminal). */
  payment_method: string;
  sender_name: string;
  recipient_name: string;
  country: string;
  confirm_number: string;
  send_amount: number;
  fee: number;
  federal_tax: number;
  total_collected: number;
  status: string;
  batch_id: string;
  employee_name: string;
}

export interface TransferListResponse {
  rows: TransferRow[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
  page_amount: number;
}

interface RecentTransfersOptions {
  // How many rows to show on the dashboard card. Defaults to 10
  // — enough to spot the most recent activity at a glance,
  // small enough to render fast.
  limit?: number;
}

// Hook: most recent transfers for the signed-in user's store(s).
// Reads `store_id` from the JWT claims so the SPA never has to
// thread it through every component. Owners with multiple stores
// will get a follow-up PR to switch between umbrellas; for now
// the v1 dashboard scopes to the home store on the JWT.
export function useRecentTransfers({ limit = 10 }: RecentTransfersOptions = {}) {
  const identity = getCurrentIdentity();
  const storeId = identity?.store_id;

  return useQuery<TransferListResponse>({
    // Disabled when there's no store_id (e.g. superadmin viewing
    // the SPA before switching to a store). Avoids a 422 from
    // the controller — it requires `store_ids` to be non-empty.
    enabled: storeId !== null && storeId !== undefined,
    queryKey: ["transfers", "recent", storeId, limit],
    queryFn: async () => {
      const params = new URLSearchParams({
        store_ids: String(storeId),
        per_page: String(limit),
        page: "1",
        sort: "send_date",
        dir: "desc",
      });
      return api<TransferListResponse>(
        `/api/v2/transfers?${params.toString()}`,
      );
    },
  });
}

/** One transfer with every field an edit round-trips (PUT replaces
 *  the whole row, so the form must send back what it read). */
export type TransferDetail = components["schemas"]["TransferDetail"];

export interface TransferResponse {
  transfer: TransferDetail;
}

export interface CreateTransferBody {
  send_date: string;
  company: string;
  service_type: string;
  payment_method?: PaymentMethod;
  sender_name: string;
  send_amount: number;
  fee?: number;
  commission?: number;
  recipient_name?: string;
  country?: string;
  recipient_phone?: string;
  sender_phone?: string;
  sender_phone_country?: string;
  sender_address?: string;
  sender_dob?: string;
  confirm_number?: string;
  status?: string;
  status_notes?: string;
  batch_id?: string;
  internal_notes?: string;
  employee_id?: number | null;
  customer_id?: number | null;
}

// POST /api/v2/transfers — server recomputes federal_tax from
// (send_amount, service_type, country, store), so the client
// CANNOT submit it (the schema's `extra="forbid"` rejects it).
// `idempotencyKey` (from `newIdempotencyKey`, one per form) makes a
// repeat save return the transfer it already created.
export async function createTransfer(
  body: CreateTransferBody,
  idempotencyKey?: string,
): Promise<TransferResponse> {
  return api<TransferResponse>("/api/v2/transfers", {
    method: "POST",
    json: body,
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

// PUT /api/v2/transfers/{id} — full replacement (no PATCH). Same
// shape as create. Server recomputes federal_tax + audits the
// before/after diff via record_transfer_audit. Cross-tenant
// updates 404 by design.
export async function updateTransfer(
  transferId: number,
  body: CreateTransferBody,
): Promise<TransferResponse> {
  return api<TransferResponse>(`/api/v2/transfers/${transferId}`, {
    method: "PUT",
    json: body,
  });
}

// DELETE /api/v2/transfers/{id} — permanent, for clearing a
// mistaken entry. Needs `transfers.delete` (store admins by
// default); the server writes an activity-log entry naming what
// was removed. Cross-store ids 404.
export async function deleteTransfer(transferId: number): Promise<void> {
  await api<void>(`/api/v2/transfers/${transferId}`, { method: "DELETE" });
}

export interface EmployeeRow {
  id: number;
  name: string;
}

interface RosterResponse {
  employees: EmployeeRow[];
}

// Hook: active store-employee roster for the JWT principal's
// store. Powers the "Processed by" dropdown on the create + edit
// forms. Returns the same envelope as
// /api/v2/transfers/employees. Inactive employees are filtered
// server-side.
export function useEmployees() {
  const identity = getCurrentIdentity();
  const storeId = identity?.store_id;
  return useQuery<RosterResponse>({
    enabled: storeId !== null && storeId !== undefined,
    queryKey: ["transfers", "employees", storeId],
    queryFn: () => api<RosterResponse>("/api/v2/transfers/employees"),
    // The roster changes infrequently — admins add cashiers at
    // most a few times a month — so a 5-minute stale window
    // keeps the dropdown responsive without spamming the API.
    staleTime: 5 * 60_000,
  });
}

export type TransferChoices = components["schemas"]["TransferChoicesResponse"];

export const TRANSFER_CHOICES_KEY = ["transfers", "choices"] as const;

// Hook: the store's company + country pick-lists for the transfer
// and ACH batch forms. Both live in Settings → General: the active
// money transfer companies (the same list the MSB daily book uses)
// and the store's transfer countries. Settings invalidates this key
// on save, so a company added there shows on the next form.
export function useTransferChoices() {
  const identity = getCurrentIdentity();
  const storeId = identity?.store_id;
  return useQuery<TransferChoices>({
    enabled: storeId !== null && storeId !== undefined,
    queryKey: [...TRANSFER_CHOICES_KEY, storeId],
    queryFn: () => api<TransferChoices>("/api/v2/transfers/choices"),
  });
}

// Hook: fetch a single transfer by id, scoped to the user's
// store(s). Server returns 404 (never 403) for cross-tenant
// lookups so tenancy boundaries stay opaque.
export function useTransfer(transferId: number | undefined) {
  const identity = getCurrentIdentity();
  const storeId = identity?.store_id;

  return useQuery<TransferResponse>({
    enabled:
      transferId !== undefined &&
      storeId !== null &&
      storeId !== undefined,
    queryKey: ["transfers", "detail", transferId, storeId],
    queryFn: async () => {
      const params = new URLSearchParams({ store_ids: String(storeId) });
      return api<TransferResponse>(
        `/api/v2/transfers/${transferId}?${params.toString()}`,
      );
    },
  });
}

// Service types exempt from the federal-tax remittance — must
// stay 1:1 with `api/Modules/Transfers/Services/tax.py`. Bill
// Payment / Top Up / Recharge are exempt because no ACH crosses
// a border for them, and a Payout brings money in rather than
// sending it; only Money Transfer carries the levy.
const TAX_EXEMPT_SERVICES: ReadonlySet<string> = new Set([
  "Bill Payment", "Top Up", "Recharge", PAYOUT_SERVICE,
]);

// Domestic countries that also skip the tax even for Money
// Transfer — mirrors `DOMESTIC_COUNTRIES` server-side.
const DOMESTIC_COUNTRIES: ReadonlySet<string> = new Set(["United States"]);

/** Client-side preview of `Transfer.federal_tax` so the cashier
 *  can sanity-check the line before submit. The server recomputes
 *  on save (CLAUDE.md invariant #9) — this is purely a sticker
 *  for the form. Mirrors `federal_tax_for` in
 *  `api/Modules/Transfers/Services/tax.py`. */
export function previewFederalTax(opts: {
  sendAmount: number | string | null | undefined;
  serviceType: string;
  country?: string | null;
  rate: number | null | undefined;
}): number {
  if (TAX_EXEMPT_SERVICES.has(opts.serviceType)) return 0;
  if (opts.country && DOMESTIC_COUNTRIES.has(opts.country.trim())) return 0;
  const amount = Number(opts.sendAmount) || 0;
  const rate = Number(opts.rate) || 0;
  return Math.round(amount * rate * 100) / 100;
}

export interface TransferFilters {
  q?: string;
  date_from?: string;
  date_to?: string;
  status?: string;
  /** Exact service type, e.g. "Payout". */
  service?: string;
  /** "cash" or "debit_card". */
  paid_by?: string;
}

interface TransfersPageOptions extends TransferFilters {
  page: number;
  perPage: number;
  /** Polling interval in ms — pass a positive number to keep the
   *  list fresh while two cashiers share an employee login on
   *  different machines. Foreground only (TanStack Query's default
   *  `refetchIntervalInBackground=false` pauses polling when the
   *  tab is hidden, so we don't burn bandwidth in a background
   *  tab). Omit to disable polling. */
  pollMs?: number;
}

// Hook: paginated transfer list with filters. Powers the
// /app/transfers page. Same backend endpoint as
// `useRecentTransfers` — different query key + filters so
// TanStack Query caches them independently.
export function useTransfers({
  page, perPage, q, date_from, date_to, status, service, paid_by, pollMs,
}: TransfersPageOptions) {
  const identity = getCurrentIdentity();
  const storeId = identity?.store_id;

  return useQuery<TransferListResponse>({
    enabled: storeId !== null && storeId !== undefined,
    // Include all filter values in the key so the cache
    // invalidates correctly when the user types.
    queryKey: [
      "transfers", "list", storeId, page, perPage,
      q ?? "", date_from ?? "", date_to ?? "", status ?? "",
      service ?? "", paid_by ?? "",
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        store_ids: String(storeId),
        page: String(page),
        per_page: String(perPage),
        sort: "send_date",
        dir: "desc",
      });
      if (q) params.set("q", q);
      if (date_from) params.set("date_from", date_from);
      if (date_to) params.set("date_to", date_to);
      if (status) params.set("status", status);
      if (service) params.set("service", service);
      if (paid_by) params.set("paid_by", paid_by);
      return api<TransferListResponse>(
        `/api/v2/transfers?${params.toString()}`,
      );
    },
    // Keep showing the previous page's data while the next
    // page is loading — avoids a flash of "Loading..." that
    // makes pagination feel laggy.
    placeholderData: (prev) => prev,
    // Multi-device sync: when pollMs is set, refetch on that
    // cadence so a second cashier's edits show up without a
    // page reload. Returns false (disabled) when no interval
    // was passed.
    refetchInterval: pollMs && pollMs > 0 ? pollMs : false,
  });
}


// ── Receipt ─────────────────────────────────────────────────

export interface ReceiptStore {
  name:             string;
  address:          string;
  phone:            string;
  email:            string;
  receipt_logo_url: string;
  receipt_footer:   string;
  receipt_tax_id:   string;
}

export interface ReceiptTransfer {
  id:                   number;
  send_date:            string;
  created_at:           string;
  company:              string;
  service_type:         string;
  payment_method:       string;
  sender_name:          string;
  sender_phone:         string;
  sender_phone_country: string;
  sender_address:       string;
  recipient_name:       string;
  recipient_phone:      string;
  country:              string;
  confirm_number:       string;
  send_amount:          number;
  fee:                  number;
  federal_tax:          number;
  total_collected:      number;
  status:               string;
  employee_name:        string;
}

export interface TransferReceiptResponse {
  store:    ReceiptStore;
  transfer: ReceiptTransfer;
}

export function useTransferReceipt(transferId: number) {
  const identity = getCurrentIdentity();
  const storeId = identity?.store_id;
  return useQuery<TransferReceiptResponse>({
    enabled:
      Number.isFinite(transferId)
      && storeId !== null && storeId !== undefined,
    queryKey: ["transfers", "receipt", transferId, storeId],
    queryFn: () =>
      api<TransferReceiptResponse>(
        `/api/v2/transfers/${transferId}/receipt`
        + `?store_ids=${storeId}`,
      ),
  });
}
