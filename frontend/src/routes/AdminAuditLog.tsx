import {
  useAdminAuditLog,
  type AdminAuditUserOption,
} from "../api/admin";
import {
  Button, Card, Field, InfoTip, PageHeader, PageShell,
  Select, space,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { AuditTable } from "../components/AuditTable";
import { AUDIT_ACTION_OPTIONS, AUDIT_TARGET_OPTIONS } from "../components/auditFilters";
import styles from "./AdminAuditLog.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtCount } from "../lib/formatters";

// /app/admin/audit-log — merged operator + transfer audit feed
// for the JWT principal's store. Filters and page live in the URL
// so the page is shareable; rows per page is the viewer's choice.

export default function AdminAuditLog() {
  const filters = useUrlFilterState(
    { target: "", action: "", user: "" },
    { pageSizeKey: "admin-audit-log" },
  );
  const { target, action, user } = filters.params;
  const { page, setParam, perPage } = filters;

  const { data, isLoading, isError, error, refetch } = useAdminAuditLog(
    page, target, action, user, perPage,
  );

  const hasFilters = !!(target || action || user);

  return (
    <PageShell>

      <PageCrumbs under="/reports" current="Audit log" />

      <PageHeader
        title={
          <>
            Audit log
            <InfoTip text="Covers transfer creates, edits, status changes and deletes, daily-report locks and unlocks, and ACH batch creates and updates. Routine daily-report auto-saves aren't logged — the lock event captures who closed the day." />
          </>
        }
        subtitle="Every admin action across the store, newest first."
      />

      <Card style={{ marginBottom: space.lg }}>
        <div className={styles.cardHeader}>
          Filters
          <span className={styles.cardHeaderCount}>
            {data ? `${fmtCount(data.total, "event")}` : "—"}
          </span>
        </div>
        <div className={styles.filtersRow}>
          <Field label="Target" style={{ minWidth: "10rem" }}>
            <Select
              value={target}
              onChange={(e) => setParam("target", e.target.value)}
            >
              {AUDIT_TARGET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Action" style={{ minWidth: "10rem" }}>
            <Select
              value={action}
              onChange={(e) => setParam("action", e.target.value)}
            >
              {AUDIT_ACTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="User" style={{ minWidth: "10rem" }}>
            <Select
              value={user}
              onChange={(e) => setParam("user", e.target.value)}
              disabled={!data}
            >
              <option value="">Any</option>
              {(data?.store_users ?? []).map((u: AdminAuditUserOption) => (
                <option key={u.id} value={String(u.id)}>
                  {u.label}{u.role !== "admin" ? ` (${u.role})` : ""}
                </option>
              ))}
            </Select>
          </Field>
          {hasFilters && (
            <Button
              tone="secondary"
              size="sm"
              onClick={filters.reset}
            >
              Clear
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <div className={styles.cardHeader}>Recent activity</div>
        <AuditTable
          rows={data?.rows}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle="No activity matches these filters."
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage, onPerPage: filters.setPerPage,
          }}
        />
      </Card>

    </PageShell>
  );
}
