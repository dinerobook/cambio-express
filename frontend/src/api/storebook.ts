// Store Daily Book (D-2) — typed client for /api/v2/storebook/*.
// Shapes come from the generated OpenAPI types (CLAUDE.md: no
// hand-written interfaces).
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import type { components } from "./openapi";
import { t, type MessageKey } from "../i18n";
import { en } from "../i18n/en";

export type StoreBookDay = components["schemas"]["StoreBookDayResponse"];
export type StoreBookMonth =
  components["schemas"]["StoreBookMonthResponse"];
export type StoreBookMonthRow =
  components["schemas"]["StoreBookMonthRow"];
export type StoreBookColumn = components["schemas"]["StoreBookColumnSpec"];
export type StoreBookSection =
  components["schemas"]["StoreBookSectionSpec"];
export type StoreBookField = components["schemas"]["StoreBookFieldSpec"];
export type StoreBookTotals = components["schemas"]["StoreBookTotals"];
export type StoreBookUpdateBody =
  components["schemas"]["StoreBookUpdateRequest"];

/** One day's sheet. The layout ships with it, so the page never
 *  holds its own copy of the field list. */
/** The day sheet's layout comes from the server in English. A
 *  column (`sb.col.<column>`), section or field (`sb.<key>`) we ship
 *  words for shows in the reader's language; one the server added or
 *  renamed shows as sent, so a server change is never hidden. */
export function storeBookLabel(
  key: string, serverLabel: string, kind: "column" | "item" = "item",
): string {
  const k = (kind === "column" ? `sb.col.${key}` : `sb.${key}`) as MessageKey;
  if (!Object.hasOwn(en, k) || serverLabel !== en[k]) return serverLabel;
  return t(k);
}

export function useStoreBookDay(day: string) {
  const identity = getCurrentIdentity();
  return useQuery<StoreBookDay>({
    enabled: identity?.store_id != null && Boolean(day),
    queryKey: ["storebook", "day", identity?.store_id, day],
    queryFn: () => api<StoreBookDay>(`/api/v2/storebook/${day}`),
  });
}

export function useStoreBookMonth(year: number, month: number) {
  const identity = getCurrentIdentity();
  return useQuery<StoreBookMonth>({
    enabled: identity?.store_id != null,
    queryKey: ["storebook", "month", identity?.store_id, year, month],
    queryFn: () =>
      api<StoreBookMonth>(
        `/api/v2/storebook/month?year=${year}&month=${month}`,
      ),
    placeholderData: (prev) => prev,
  });
}

export async function updateStoreBookDay(
  day: string, body: StoreBookUpdateBody,
): Promise<StoreBookDay> {
  return api<StoreBookDay>(`/api/v2/storebook/${day}`, {
    method: "PATCH", json: body,
  });
}

export async function setStoreBookLock(
  day: string, locked: boolean,
): Promise<StoreBookDay> {
  return api<StoreBookDay>(`/api/v2/storebook/${day}/lock`, {
    method: "POST", json: { locked },
  });
}

/** Take the register's imported number back for one field. */
export async function restoreStoreBookField(
  day: string, fieldKey: string,
): Promise<StoreBookDay> {
  return api<StoreBookDay>(`/api/v2/storebook/${day}/restore`, {
    method: "POST", json: { field_key: fieldKey },
  });
}
