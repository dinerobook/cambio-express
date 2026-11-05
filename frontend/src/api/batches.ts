// Batches API hooks. Backed by /api/v2/batches.
//
// One read-side endpoint today: list-all-for-store with sort
// + precomputed transfers_total + variance + transfer_count.
// Write-side (create / edit / link transfers) stays on the
// legacy Flask path.

import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { components } from "./openapi";
import { getCurrentIdentity } from "../lib/auth";
import type { PillTone } from "../components/ui";
import { t, type MessageKey } from "../i18n";

/** Batch status → Pill tone (UI-STANDARDS §3). Statuses are
 *  BatchForm's list; unknown values fall back to neutral. */
export const BATCH_STATUS_TONES: Record<string, PillTone> = {
  Pending:  "warning",
  Cleared:  "success",
  Returned: "negative",
  Held:     "info",
};

/** The statuses a batch can have. Stored and sent in English; shown
 *  through ``batchStatusLabel`` (UI-STANDARDS §10). */
export const BATCH_STATUSES = ["Pending", "Cleared", "Returned", "Held"] as const;

const BATCH_STATUS_KEYS: Record<(typeof BATCH_STATUSES)[number], MessageKey> = {
  Pending: "batch.statusPending",
  Cleared: "batch.statusCleared",
  Returned: "batch.statusReturned",
  Held: "batch.statusHeld",
};

/** A stored batch status in the person's language; an unknown value
 *  is shown as stored. */
export function batchStatusLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return Object.hasOwn(BATCH_STATUS_KEYS, value)
    ? t(BATCH_STATUS_KEYS[value as keyof typeof BATCH_STATUS_KEYS])
    : value;
}

/** One batch with its server-computed totals. `variance` is
 *  `ach_amount - expected_ach`; `expected_ach` is the linked sends
 *  less the debit card credit from the company's previous batch
 *  (Transfers INVARIANTS "Debit card sends"). */
export type BatchRow = components["schemas"]["BatchRow"];

export type BatchListResponse = components["schemas"]["BatchListResponse"];

export type BatchSort =
  | "ach_date" | "company" | "batch_ref" | "ach_amount" | "status" | "";
export type BatchDir = "asc" | "desc";

export interface BatchWriteBody {
  ach_date: string;
  company: string;
  batch_ref: string;
  ach_amount: number;
  transfer_dates?: string;
  status?: string;
  reconciled?: boolean;
  notes?: string;
}

export function useBatch(batchId: number | undefined) {
  const identity = getCurrentIdentity();
  return useQuery<{ batch: BatchRow }>({
    enabled:
      Number.isFinite(batchId) &&
      identity?.store_id != null,
    queryKey: ["batches", "detail", identity?.store_id, batchId],
    queryFn: () => api<{ batch: BatchRow }>(`/api/v2/batches/${batchId}`),
  });
}

export async function createBatch(
  body: BatchWriteBody,
): Promise<{ batch: BatchRow }> {
  return api<{ batch: BatchRow }>(
    "/api/v2/batches",
    { method: "POST", json: body },
  );
}

export async function updateBatch(
  batchId: number, body: BatchWriteBody,
): Promise<{ batch: BatchRow }> {
  return api<{ batch: BatchRow }>(
    `/api/v2/batches/${batchId}`,
    { method: "PUT", json: body },
  );
}

export type BatchLinkedTransferRow = components["schemas"]["BatchLinkedTransferRow"];

export interface BatchListQuery {
  sort?: BatchSort; direction?: BatchDir; page?: number; perPage?: number;
}

/** One page of the ACH batches list — the request the list page and
 *  its CSV export both make. */
export function fetchBatchesPage({
  sort = "", direction = "desc", page = 1, perPage = 50,
}: BatchListQuery = {}): Promise<BatchListResponse> {
  const params = new URLSearchParams();
  if (sort) params.set("sort", sort);
  params.set("direction", direction);
  params.set("page", String(page));
  params.set("per_page", String(perPage));
  return api<BatchListResponse>(`/api/v2/batches?${params.toString()}`);
}

export function useBatches(query: BatchListQuery = {}) {
  const identity = getCurrentIdentity();
  const enabled = identity?.store_id != null;
  const { sort = "", direction = "desc", page = 1, perPage = 50 } = query;
  return useQuery<BatchListResponse>({
    enabled,
    queryKey: ["batches", "list", identity?.store_id, sort, direction, page, perPage],
    queryFn: () => fetchBatchesPage(query),
    placeholderData: (prev) => prev,
  });
}
