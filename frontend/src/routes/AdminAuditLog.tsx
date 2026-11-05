import {
  useAdminAuditLog,
  type AdminAuditUserOption,
} from "../api/admin";
import {
  Button, Card, Field, InfoTip, PageHeader, PageShell,
  Select, space,
} from "../components/ui";
import { roleLabel } from "../api/roles";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { AuditTable } from "../components/AuditTable";
import { AUDIT_ACTION_OPTIONS, AUDIT_TARGET_OPTIONS } from "../components/auditFilters";
import styles from "./AdminAuditLog.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import { tn, useT } from "../i18n";

// /app/admin/audit-log — merged operator + transfer audit feed
// for the JWT principal's store. Filters and page live in the URL
// so the page is shareable; rows per page is the viewer's choice.

export default function AdminAuditLog() {
  const t = useT();
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

      <PageCrumbs under="/reports" current={t("audit.logTitle")} />

      <PageHeader
        title={
          <>
            {t("audit.logTitle")}
            <InfoTip text={t("audit.logTip")} />
          </>
        }
        subtitle={t("audit.logSubtitle")}
      />

      <Card style={{ marginBottom: space.lg }}>
        <div className={styles.cardHeader}>
          {t("audit.filters")}
          <span className={styles.cardHeaderCount}>
            {data ? tn("audit.events", data.total, fmtNumber) : "—"}
          </span>
        </div>
        <div className={styles.filtersRow}>
          <Field label={t("audit.target")} style={{ minWidth: "10rem" }}>
            <Select
              value={target}
              onChange={(e) => setParam("target", e.target.value)}
            >
              {AUDIT_TARGET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{t(o.label)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("audit.action")} style={{ minWidth: "10rem" }}>
            <Select
              value={action}
              onChange={(e) => setParam("action", e.target.value)}
            >
              {AUDIT_ACTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{t(o.label)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("audit.user")} style={{ minWidth: "10rem" }}>
            <Select
              value={user}
              onChange={(e) => setParam("user", e.target.value)}
              disabled={!data}
            >
              <option value="">{t("audit.any")}</option>
              {(data?.store_users ?? []).map((u: AdminAuditUserOption) => (
                <option key={u.id} value={String(u.id)}>
                  {u.label}{u.role !== "admin" ? ` (${roleLabel(u.role)})` : ""}
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
              {t("audit.clear")}
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <div className={styles.cardHeader}>{t("audit.recent")}</div>
        <AuditTable
          rows={data?.rows}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={t("audit.logEmpty")}
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
