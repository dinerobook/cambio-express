// Reports API hooks. Backed by /api/v2/reports/* — every endpoint
// shares the same `(period, store_ids)` query shape and returns
// `{rows, totals}` envelopes. We expose a single hook factory that
// the routes use to keep the wiring consistent.

import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";

export interface AggregatedTotals {
  count: number;
  sent: number;
  fees: number;
  tax: number;
}

export interface AggregatedRowBase {
  count: number;
  sent: number;
  fees: number;
  tax: number;
  avg: number;
}

// Each report adds its own identity column on top of the
// AggregatedRowBase numeric envelope.
export interface CompanyRow      extends AggregatedRowBase { company: string; }
export interface ServiceTypeRow  extends AggregatedRowBase { service_type: string; }
export interface CountryRow      extends AggregatedRowBase { country: string; }
export interface RecipientRow    extends AggregatedRowBase { recipient: string; }

export interface ReportEnvelope<R> {
  rows: R[];
  totals: AggregatedTotals;
}

// ── Report-center index ─────────────────────────────────────

export interface ReportListRow {
  key: string;
  label: string;
  description: string;
  url: string | null;
  status: string;  // "ready" | "coming_soon"
}

export interface ReportListCategory {
  key: string;
  label: string;
  icon: string;  // inline stroke SVG
  reports: ReportListRow[];
}

export interface ReportListResponse {
  categories: ReportListCategory[];
}

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
