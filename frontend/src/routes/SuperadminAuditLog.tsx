import {
  fetchSuperadminAuditLog,
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
import { tn, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// Platform-wide superadmin audit log at /app/superadmin/audit-log.
// Mirrors the legacy /superadmin/reports/audit-log report —
// every superadmin mutation with actor + target + details.
//
// Action filter is a server-side substring match (case-insensitive)
// so an operator can drill into "trial" or "comp_plan" without
// exporting the full table. It applies as you type (300ms debounce,
// 2-char minimum) and lives in the URL, like every list page.

export default function SuperadminAuditLog() {
  const t = useT();
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
        <PageHeader title={navWord("Audit log")} />
        <Empty>{t("sa.scopeRequired")}</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("Audit log")}
        subtitle={data
          ? (action
            ? tn("saAudit.entriesMatching", data.total, fmtNumber, { action })
            : tn("saAudit.entries", data.total, fmtNumber))
          : "—"}
        actions={(
          <Input
            type="search"
            value={filters.draft.action ?? filters.params.action}
            placeholder={t("saAudit.filter")}
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
          emptyTitle={t("saAudit.empty")}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "platform-audit-log",
            fetchPage: (p, n) => fetchSuperadminAuditLog(p, action, n).then((r) => ({
              ...r, rows: r.rows.map(toAuditTableRow),
            })),
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
