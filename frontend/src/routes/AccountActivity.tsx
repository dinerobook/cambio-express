import { useMyActivity } from "../api/account";
import {
  Button, Card, InfoTip, PageHeader, PageShell, space,
} from "../components/ui";
import { AuditTable } from "../components/AuditTable";
import { AuditFilterFields } from "../components/AuditFilterFields";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "./AccountActivity.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import { tn, useT } from "../i18n";

// /app/account/activity — cross-store per-user audit feed.
// Mirrors /app/admin/audit-log visually but is scoped to "things
// I did" across every store I've touched (handy for a multi-
// store cashier or an owner who works behind the counter).

export default function AccountActivity() {
  const t = useT();
  const filters = useUrlFilterState(
    { target: "", action: "" },
    { pageSizeKey: "my-activity" },
  );
  const { target, action } = filters.params;
  const { page, setParam, perPage } = filters;

  const { data, isLoading, isError, error, refetch } = useMyActivity({
    target, action, page, perPage,
  });

  const hasFilters = !!(target || action);

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={
          <>
            {t("audit.myTitle")}
            <InfoTip text={t("audit.myTip")} />
          </>
        }
        subtitle={t("audit.mySubtitle")}
      />

      <Card style={{ marginBottom: space.lg }}>
        <div className={styles.cardHeader}>
          {t("audit.filters")}
          <span className={styles.cardHeaderCount}>
            {data ? tn("audit.events", data.total, fmtNumber) : "—"}
          </span>
        </div>
        <div className={styles.filtersRow}>
          <AuditFilterFields
            target={target} action={action}
            onTarget={(v) => setParam("target", v)}
            onAction={(v) => setParam("action", v)}
          />
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
          who="store"
          rows={data?.rows}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={t("audit.myEmpty")}
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
