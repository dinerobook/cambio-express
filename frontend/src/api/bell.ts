import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import type { components } from "./openapi";

// The top-bar notification bell. The server works every item out
// live from the books (api/Modules/Notifications/Services/bell); the
// SPA only shows them, through the one item table in
// `lib/bellItems.ts`.

export type BellResponse = components["schemas"]["BellResponse"];
export type BellItem = components["schemas"]["BellItem"];
export type BellKind = BellItem["kind"];

export const BELL_QUERY_KEY = ["notifications", "bell"] as const;

/** The signed-in person's bell. Polls once a minute and refreshes
 *  when the window regains focus, so the count stays live without a
 *  websocket. A failed load leaves the last answer in place: the
 *  bell never takes the page down with it. */
export function useBell() {
  const identity = getCurrentIdentity();
  return useQuery<BellResponse>({
    enabled: identity != null,
    queryKey: BELL_QUERY_KEY,
    queryFn: () => api<BellResponse>("/api/v2/notifications/bell"),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}

/** Dismiss / undo one item, updating the cached list at once (the
 *  row leaves before the server answers) and re-reading after. */
export function useBellActions() {
  const qc = useQueryClient();

  function drop(key: string) {
    qc.setQueryData<BellResponse>(BELL_QUERY_KEY, (prev) => (
      prev ? { ...prev, items: prev.items.filter((i) => i.key !== key) } : prev
    ));
  }

  async function dismiss(item: BellItem): Promise<void> {
    const before = qc.getQueryData<BellResponse>(BELL_QUERY_KEY);
    drop(item.key);
    try {
      await api("/api/v2/notifications/bell/dismiss", {
        method: "POST", json: { key: item.key },
      });
    } catch (err) {
      // Put the row back: it was not dismissed.
      if (before) qc.setQueryData(BELL_QUERY_KEY, before);
      throw err;
    } finally {
      void qc.invalidateQueries({ queryKey: BELL_QUERY_KEY });
    }
  }

  async function undismiss(item: BellItem): Promise<void> {
    try {
      await api("/api/v2/notifications/bell/undismiss", {
        method: "POST", json: { key: item.key },
      });
    } finally {
      void qc.invalidateQueries({ queryKey: BELL_QUERY_KEY });
    }
  }

  return { dismiss, undismiss };
}
