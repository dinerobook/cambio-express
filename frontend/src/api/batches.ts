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

/** Batch status → Pill tone (UI-STANDARDS §3). Statuses are
 *  BatchForm's list; unknown values fall back to neutral. */
export const BATCH_STATUS_TONES: Record<string, PillTone> = {
  Pending:  "warning",
  Cleared:  "success",
  Returned: "negative",
  Held:     "info",
};

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

export interface BatchLinkedTransferRow {
  id: number;
  send_date: string;
  company: string;
  sender_name: string;
  recipient_name: string;
  country: string;
  confirm_number: string;
  send_amount: number;
  fee: number;
  federal_tax: number;
  total_collected: number;
  status: string;
}

export function useBatches({
  sort = "", direction = "desc", page = 1, perPage = 50,
}: { sort?: BatchSort; direction?: BatchDir; page?: number; perPage?: number } = {}) {
  const identity = getCurrentIdentity();
  const enabled = identity?.store_id != null;
  return useQuery<BatchListResponse>({
    enabled,
    queryKey: ["batches", "list", identity?.store_id, sort, direction, page, perPage],
    queryFn: () => {
      const params = new URLSearchParams();
      if (sort) params.set("sort", sort);
      params.set("direction", direction);
      params.set("page", String(page));
      params.set("per_page", String(perPage));
      return api<BatchListResponse>(
        `/api/v2/batches?${params.toString()}`,
      );
    },
    placeholderData: (prev) => prev,
  });
}
