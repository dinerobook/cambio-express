import {
  useSuperadminAuditLog,
  type SuperadminAuditRow,
} from "../api/superadmin";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  Card, Empty, Input, PageHeader, PageShell,
} from "../components/ui";
import { AuditTable, type AuditTableRow } from "../components/AuditTable";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";

// Platform-wide superadmin audit log at /app/superadmin/audit-log.
// Mirrors the legacy /superadmin/reports/audit-log report —
// every superadmin mutation with actor + target + details.
//
// Action filter is a server-side substring match (case-insensitive)
// so an operator can drill into "trial" or "comp_plan" without
// exporting the full table. It applies as you type (300ms debounce,
// 2-char minimum) and lives in the URL, like every list page.

export default function SuperadminAuditLog() {
  const identity = getCurrentIdentity();
  const filters = useUrlFilterState(
    { action: "" }, { pageSizeKey: "superadmin-audit-log" },
  );
  const action = filters.params.action.trim();

  const { data, isLoading, isError, error, refetch } = useSuperadminAuditLog(
    filters.page, action, filters.perPage,
  );

  if (identity?.role !== "superadmin") {
    return (
      <PageShell>
        <PageHeader title="Audit log" />
        <Empty>Superadmin scope required.</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title="Audit log"
        subtitle={data
          ? `${fmtNumber(data.total)} entries${
              action ? ` matching "${action}"` : ""
            }`
          : "—"}
        actions={(
          <Input
            type="search"
            value={filters.draft.action ?? filters.params.action}
            placeholder="Filter by action…"
            onChange={(e) => filters.debounced("action", e.target.value)}
            style={{ maxWidth: "20rem" }}
          />
        )}
      />

      <Card>
        <AuditTable
          rows={data?.rows.map(toAuditTableRow)}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle="No audit entries match."
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

/** The platform log's rows in the shared audit table's shape: the
 *  acting superadmin is the actor, `type#id` the target. */
function toAuditTableRow(r: SuperadminAuditRow): AuditTableRow {
  return {
    ts: r.created_at,
    user_name: r.admin_name,
    action: r.action,
    target_type: r.target_type,
    target_id: r.target_id,
    target_label: r.target_type && r.target_id ? `#${r.target_id}` : "",
    summary: r.details,
    source: "superadmin",
  };
}
