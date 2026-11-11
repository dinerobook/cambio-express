import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { components } from "./openapi";
import { t, type MessageKey } from "../i18n";

// A ticket's kind pill. A kind the SPA does not list shows as sent.
const KIND_PILLS: Record<string, MessageKey> = {
  refund: "posTx.kind.refund",
  void: "posTx.kind.void",
  financial: "posTx.kind.financial",
  other: "posTx.kind.other",
};
export function ticketKindLabel(kind: string): string {
  return Object.hasOwn(KIND_PILLS, kind) ? t(KIND_PILLS[kind]) : kind;
}


// Typed straight off the FastAPI OpenAPI spec (CLAUDE.md standard).
export type NaxmlPreview = components["schemas"]["NaxmlPreviewResponse"];
export type ImportRegisterRow = components["schemas"]["ImportRegisterRow"];
export type MappingRow = components["schemas"]["MappingRow"];
export type NaxmlCommitResult = components["schemas"]["NaxmlCommitResponse"];
export type AgentKey = components["schemas"]["AgentKeyRow"];
export type StagedDay = components["schemas"]["StagedDayRow"];

type MappingListResponse = components["schemas"]["MappingListResponse"];
type AgentKeyListResponse = components["schemas"]["AgentKeyListResponse"];
type AgentKeyIssueResponse = components["schemas"]["AgentKeyIssueResponse"];
type StagedDaysResponse = components["schemas"]["StagedDaysResponse"];

export async function previewNaxml(
  contentBase64: string,
): Promise<NaxmlPreview> {
  return api<NaxmlPreview>("/api/v2/posimport/naxml/preview", {
    method: "POST", json: { content_base64: contentBase64 },
  });
}

export async function saveMappings(
  mappings: Array<{ merchandise_code: string; department_id: number }>,
): Promise<MappingListResponse> {
  return api<MappingListResponse>("/api/v2/posimport/mapping", {
    method: "PUT", json: { mappings },
  });
}

export async function commitNaxml(
  contentBase64: string, day: string,
): Promise<NaxmlCommitResult> {
  return api<NaxmlCommitResult>("/api/v2/posimport/naxml/commit", {
    method: "POST", json: { content_base64: contentBase64, day },
  });
}

export function useAgentKeys() {
  return useQuery<AgentKeyListResponse>({
    queryKey: ["posimport", "agent-keys"],
    queryFn: () => api<AgentKeyListResponse>("/api/v2/posimport/agent-keys"),
  });
}

export async function issueAgentKey(
  label: string,
): Promise<AgentKeyIssueResponse> {
  return api<AgentKeyIssueResponse>("/api/v2/posimport/agent-keys", {
    method: "POST", json: { label },
  });
}

export async function revokeAgentKey(
  id: number,
): Promise<AgentKeyListResponse> {
  return api<AgentKeyListResponse>(
    `/api/v2/posimport/agent-keys/${id}/revoke`, { method: "POST" },
  );
}

export function useStagedDays() {
  return useQuery<StagedDaysResponse>({
    queryKey: ["posimport", "staged"],
    queryFn: () => api<StagedDaysResponse>("/api/v2/posimport/staged"),
    refetchInterval: 60_000,   // agent pushes land continuously
  });
}

export async function commitStagedDay(
  day: string,
): Promise<NaxmlCommitResult> {
  return api<NaxmlCommitResult>("/api/v2/posimport/staged/commit", {
    method: "POST", json: { day },
  });
}


// ── Price-book warm start (P2-3) ─────────────────────────────

export type PriceBookHarvest =
  components["schemas"]["PriceBookHarvestResponse"];
export type PriceBookSeedResult =
  components["schemas"]["PriceBookSeedResponse"];

export async function previewPriceBookSeed(): Promise<PriceBookHarvest> {
  return api<PriceBookHarvest>("/api/v2/posimport/pricebook/preview");
}

export async function commitPriceBookSeed(): Promise<PriceBookSeedResult> {
  return api<PriceBookSeedResult>("/api/v2/posimport/pricebook/commit", {
    method: "POST",
  });
}

// ── Item movement (G-2) ──────────────────────────────────────

export type ItemMovement =
  components["schemas"]["ItemMovementResponse"];

export interface ItemMovementQuery {
  start: string; end: string; q: string; page: number; perPage?: number;
}

/** One page of item movement — the request the page and its CSV
 *  export both make. */
export function fetchItemMovementPage(params: ItemMovementQuery): Promise<ItemMovement> {
  const p = new URLSearchParams({
    start: params.start, end: params.end,
    page: String(params.page),
    per_page: String(params.perPage ?? 50),
  });
  if (params.q) p.set("q", params.q);
  return api<ItemMovement>(`/api/v2/posimport/item-movement?${p.toString()}`);
}

export function useItemMovement(params: ItemMovementQuery) {
  return useQuery<ItemMovement>({
    enabled: Boolean(params.start && params.end),
    queryKey: ["posimport", "item-movement", params],
    placeholderData: (prev) => prev,
    queryFn: () => fetchItemMovementPage(params),
  });
}


// ── Transactions (G-6) ──────────────────────────────────────

export type PosTransactionRow = components["schemas"]["PosTransactionRow"];
export type PosTransaction = components["schemas"]["PosTransactionDetail"];
export type PosTransactionLine =
  components["schemas"]["PosTransactionLineRow"];
export type PosTransactionTender =
  components["schemas"]["PosTransactionTenderRow"];

type PosTransactionListResponse =
  components["schemas"]["PosTransactionListResponse"];
type PosTransactionDetailResponse =
  components["schemas"]["PosTransactionDetailResponse"];

export interface PosTransactionQuery {
  start: string;
  end: string;
  q?: string;
  kind?: string;
  registerId?: string;
  voidedOnly?: boolean;
  page?: number;
  perPage?: number;
}

function posTransactionsQs(params: PosTransactionQuery): string {
  const qs = new URLSearchParams({
    start: params.start,
    end: params.end,
    page: String(params.page ?? 1),
    per_page: String(params.perPage ?? 50),
  });
  if (params.q) qs.set("q", params.q);
  if (params.kind) qs.set("kind", params.kind);
  if (params.registerId) qs.set("register_id", params.registerId);
  if (params.voidedOnly) qs.set("voided_only", "true");
  return qs.toString();
}

/** One page of POS transactions — the request the page and its CSV
 *  export both make. */
export function fetchPosTransactionsPage(
  params: PosTransactionQuery,
): Promise<PosTransactionListResponse> {
  return api<PosTransactionListResponse>(
    `/api/v2/posimport/transactions?${posTransactionsQs(params)}`,
  );
}

export function useTransactions(params: PosTransactionQuery) {
  const qs = posTransactionsQs(params);
  return useQuery<PosTransactionListResponse>({
    // Both dates must be present or the server 422s on the range.
    enabled: params.start.length === 10 && params.end.length === 10,
    queryKey: ["posimport", "transactions", qs],
    queryFn: () => fetchPosTransactionsPage(params),
    placeholderData: (prev) => prev,
  });
}

export function useTransaction(id: number | null) {
  return useQuery<PosTransactionDetailResponse>({
    enabled: id != null && id > 0,
    queryKey: ["posimport", "transaction", id],
    queryFn: () => api<PosTransactionDetailResponse>(
      `/api/v2/posimport/transactions/${id}`,
    ),
  });
}
