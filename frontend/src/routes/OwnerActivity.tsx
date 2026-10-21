import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { Card, Input, PageHeader, PageShell } from "../components/ui";
import { AuditTable, type AuditTableRow } from "../components/AuditTable";
import { PageCrumbs } from "../components/PageCrumbs";

interface ActivityRow {
  type: string;
  store_id: number;
  store_name: string;
  user_name: string;
  user_role: string;
  action: string;
  target_type: string;
  target_label: string;
  summary: string;
  created_at: string;
}

interface ActivityResponse {
  rows: ActivityRow[];
  total: number;
  page: number;
  total_pages: number;
}

function useOwnerActivity(q: string, page: number, perPage: number) {
  const identity = getCurrentIdentity();
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  params.set("page", String(page));
  params.set("per_page", String(perPage));
  return useQuery<ActivityResponse>({
    // The server admits the superadmin too, for support.
    enabled: identity?.role === "owner" || identity?.role === "superadmin",
    queryKey: ["owner-activity", q, page, perPage],
    queryFn: () => api<ActivityResponse>(`/api/v2/owner/activity?${params}`),
    placeholderData: (prev) => prev,
  });
}

export default function OwnerActivity() {
  const filters = useUrlFilterState({ q: "" }, { pageSizeKey: "owner-activity" });
  const { data, isLoading, isError, error, refetch } = useOwnerActivity(
    filters.params.q, filters.page, filters.perPage,
  );

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title="Activity stream"
        subtitle="Recent actions across all your stores"
      />

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <Input
          type="search"
          aria-label="Search"
          style={{ width: "20rem", maxWidth: "100%" }}
          placeholder="Search by user, action, or summary…"
          value={filters.draft.q ?? filters.params.q}
          onChange={(e) => filters.debounced("q", e.target.value)}
        />
      </div>

      <Card>
        <AuditTable
          who="both"
          rows={data?.rows.map(toAuditTableRow)}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          errorMessage="Could not load activity."
          emptyTitle="No activity"
          emptyBody="No matching events found."
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
        />
      </Card>
    </PageShell>
  );
}

/** The owner feed's rows in the shared audit table's shape. */
function toAuditTableRow(r: ActivityRow): AuditTableRow {
  return {
    ts: r.created_at,
    store_name: r.store_name || `#${r.store_id}`,
    user_name: r.user_name,
    user_role: r.user_role,
    action: r.action,
    target_type: r.target_type,
    target_id: r.target_label,
    target_label: r.target_type === "transfer" && r.target_label
      ? `Transfer #${r.target_label}` : r.target_label,
    summary: r.summary,
    source: r.type,
  };
}
