import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { Card, Input, PageHeader, PageShell } from "../components/ui";
import { AuditTable, type AuditTableRow } from "../components/AuditTable";
import { PageCrumbs } from "../components/PageCrumbs";
import type { components } from "../api/openapi";
import { t, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

type ActivityRow = components["schemas"]["OwnerActivityRow"];
type ActivityResponse = components["schemas"]["OwnerActivityListResponse"];

/** One page of the owner's activity stream — the request the page
 *  and its CSV export both make. */
function fetchOwnerActivity(q: string, page: number, perPage: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  params.set("page", String(page));
  params.set("per_page", String(perPage));
  return api<ActivityResponse>(`/api/v2/owner/activity?${params}`);
}

function useOwnerActivity(q: string, page: number, perPage: number) {
  const identity = getCurrentIdentity();
  return useQuery<ActivityResponse>({
    // The server admits the superadmin too, for support.
    enabled: identity?.role === "owner" || identity?.role === "superadmin",
    queryKey: ["owner-activity", q, page, perPage],
    queryFn: () => fetchOwnerActivity(q, page, perPage),
    placeholderData: (prev) => prev,
  });
}

export default function OwnerActivity() {
  useT(); // re-render on a language switch
  const filters = useUrlFilterState({ q: "" }, { pageSizeKey: "owner-activity" });
  const { data, isLoading, isError, error, refetch } = useOwnerActivity(
    filters.params.q, filters.page, filters.perPage,
  );

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title={navWord("Activity stream")}
        subtitle={t("owner.activitySubtitle")}
      />

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <Input
          type="search"
          aria-label={t("owner.search")}
          style={{ width: "20rem", maxWidth: "100%" }}
          placeholder={t("owner.activitySearch")}
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
          errorMessage={t("owner.activityLoadFailed")}
          emptyTitle={t("owner.noActivity")}
          emptyBody={t("owner.noActivityBody")}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "activity",
            fetchPage: (p, n) => fetchOwnerActivity(filters.params.q, p, n).then((r) => ({
              ...r, rows: r.rows.map(toAuditTableRow),
            })),
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
      ? t("transfer.number", { id: r.target_label }) : r.target_label,
    summary: r.summary,
    source: r.type,
  };
}
