// Reports API hooks. Backed by /api/v2/reports/* — every endpoint
// shares the same `(period, store_ids)` query shape and returns
// `{rows, totals}` envelopes. We expose a single hook factory that
// the routes use to keep the wiring consistent.

import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import type { components } from "./openapi";

export type AggregatedTotals = components["schemas"]["AggregatedTotals"];

// Each report row is the aggregated numbers plus its own identity
// column (company / service type / country / recipient).
export type CompanyRow = components["schemas"]["CompanyRow"];
export type ServiceTypeRow = components["schemas"]["ServiceTypeRow"];
export type CountryRow = components["schemas"]["CountryRow"];
export type RecipientRow = components["schemas"]["RecipientRow"];

// ── Report-center index ─────────────────────────────────────

export type ReportListResponse = components["schemas"]["ReportListResponse"];

export function useReportList(collection: "msb" | "store" = "msb") {
  const identity = getCurrentIdentity();
  return useQuery<ReportListResponse>({
    enabled: identity?.user_id != null,
    queryKey: ["reports", "index", collection, identity?.user_id],
    queryFn: () =>
      api<ReportListResponse>(`/api/v2/reports?collection=${collection}`),
  });
}

export function useOwnerReportList() {
  const identity = getCurrentIdentity();
  return useQuery<ReportListResponse>({
    enabled: identity?.role === "owner",
    queryKey: ["owner", "reports", "index", identity?.user_id],
    queryFn: () => api<ReportListResponse>("/api/v2/owner/reports"),
  });
}
