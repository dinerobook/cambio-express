import { useMyActivity } from "../api/account";
import {
  Breadcrumbs,
  Button, Card, Field, InfoTip, PageHeader, PageShell,
  Select, space,
} from "../components/ui";
import { AuditTable } from "../components/AuditTable";
import { AUDIT_ACTION_OPTIONS, AUDIT_TARGET_OPTIONS } from "../components/auditFilters";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "./AccountActivity.module.css";

// /app/account/activity — cross-store per-user audit feed.
// Mirrors /app/admin/audit-log visually but is scoped to "things
// I did" across every store I've touched (handy for a multi-
// store cashier or an owner who works behind the counter).

export default function AccountActivity() {
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

      <Breadcrumbs crumbs={[{ label: "Account", to: "/settings" }, { label: "Activity" }]} />

      <PageHeader
        title={
          <>
            My activity
            <InfoTip text="Covers your transfer creates, edits, status changes and deletes, daily-report locks and unlocks, and ACH batch creates and updates across every store you've touched." />
          </>
        }
        subtitle="Your recent page visits and actions."
      />

      <Card style={{ marginBottom: space.lg }}>
        <div className={styles.cardHeader}>
          Filters
          <span className={styles.cardHeaderCount}>
            {data ? `${data.total.toLocaleString()} ${data.total === 1 ? "event" : "events"}` : "—"}
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
          who="store"
          rows={data?.rows}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle="Nothing here yet — once you log a transfer, lock a daily book, or save a batch you'll see it."
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
