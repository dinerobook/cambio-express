import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { t, type MessageKey } from "../i18n";
import type { components } from "./openapi";

// The store's Developer tab (api/Modules/Developer): every file the
// register sent, for a superadmin signed in AS the store. The server
// refuses these routes to everyone else; the page also sends anyone
// else home.

export type DevFileRow = components["schemas"]["DevFileRow"];
export type DevFileListResponse = components["schemas"]["DevFileListResponse"];
export type DevFileDetailResponse = components["schemas"]["DevFileDetailResponse"];

export interface DevFilesQuery {
  q: string;
  status: string;
  kind: string;
  start: string;
  end: string;
  sort: string;
  direction: "asc" | "desc";
  page: number;
  perPage: number;
}

function devFilesQs(p: DevFilesQuery): string {
  const qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  if (p.status) qs.set("status", p.status);
  if (p.kind) qs.set("kind", p.kind);
  if (p.start) qs.set("start", p.start);
  if (p.end) qs.set("end", p.end);
  qs.set("sort", p.sort);
  qs.set("direction", p.direction);
  qs.set("page", String(p.page));
  qs.set("per_page", String(p.perPage));
  return qs.toString();
}

export function fetchDevFilesPage(p: DevFilesQuery): Promise<DevFileListResponse> {
  return api<DevFileListResponse>(`/api/v2/developer/files?${devFilesQs(p)}`);
}

export function useDevFiles(p: DevFilesQuery, enabled = true) {
  const qs = devFilesQs(p);
  return useQuery<DevFileListResponse>({
    enabled,
    queryKey: ["developer", "files", qs],
    queryFn: () => fetchDevFilesPage(p),
    placeholderData: (prev) => prev,
  });
}

export function useDevFile(id: number | null, enabled = true) {
  return useQuery<DevFileDetailResponse>({
    enabled: enabled && id != null && id > 0,
    queryKey: ["developer", "file", id],
    queryFn: () => api<DevFileDetailResponse>(`/api/v2/developer/files/${id}`),
  });
}

const EVENT_LABELS: Record<string, MessageKey> = {
  sale: "dev.event.sale",
  refund: "dev.event.refund",
  void: "dev.event.void",
  financial: "dev.event.financial",
  other: "dev.event.other",
};

/** What a file is, in words: the register event it holds, "Period
 *  report", or "Unreadable". Call during render (language switch). */
export function devFileTypeLabel(row: Pick<DevFileRow, "kind" | "event_kind">): string {
  if (row.kind === "movement") return t("dev.kindMovement");
  if (row.kind === "unknown") return t("dev.kindUnknown");
  return Object.hasOwn(EVENT_LABELS, row.event_kind)
    ? t(EVENT_LABELS[row.event_kind])
    : row.event_kind || t("dev.kindJournal");
}

/** The file itself: plain text in a new tab, or the exact bytes as a
 *  download. A plain link — the sign-in cookie goes with it. */
export function devFileRawUrl(id: number, download = false): string {
  return `/api/v2/developer/files/${id}/raw${download ? "?download=1" : ""}`;
}
