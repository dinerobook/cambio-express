import { useSearchParams } from "react-router-dom";

import { useMyActivity } from "../api/account";
import {
  Breadcrumbs,
  Button, Card, Field, InfoTip, PageHeader, PageShell,
  Pager, Select, space, TableStates,
} from "../components/ui";
import { AuditTable } from "../components/AuditTable";
import styles from "./AccountActivity.module.css";

// /app/account/activity — cross-store per-user audit feed.
// Mirrors /app/admin/audit-log visually but is scoped to "things
// I did" across every store I've touched (handy for a multi-
// store cashier or an owner who works behind the counter).

export default function AccountActivity() {
  const [sp, setSP] = useSearchParams();
  const page   = Number(sp.get("page") ?? 1) || 1;
  const target = sp.get("target") ?? "";
  const action = sp.get("action") ?? "";

  const { data, isLoading, isError, error, refetch } = useMyActivity({
    target, action, page,
  });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else       next.delete(key);
    if (key !== "page") next.delete("page");
    setSP(next, { replace: true });
  }

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
              <option value="">All</option>
              <option value="transfer">Transfer</option>
              <option value="daily_report">Daily Report</option>
              <option value="batch">ACH Batch</option>
            </Select>
          </Field>
          <Field label="Action" style={{ minWidth: "10rem" }}>
            <Select
              value={action}
              onChange={(e) => setParam("action", e.target.value)}
            >
              <option value="">All</option>
              <option value="create">Create</option>
              <option value="update">Update</option>
              <option value="delete">Delete</option>
              <option value="lock">Lock</option>
              <option value="unlock">Unlock</option>
              <option value="status_changed">Status changed</option>
            </Select>
          </Field>
          {hasFilters && (
            <Button
              tone="secondary"
              size="sm"
              onClick={() => setSP(new URLSearchParams(), { replace: true })}
            >
              Clear
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <div className={styles.cardHeader}>
          Recent activity
          {data && (
            <span className={styles.cardHeaderPage}>
              Page {data.page} of {data.total_pages}
            </span>
          )}
        </div>

        <TableStates
          isLoading={isLoading} isError={isError} error={error}
          isEmpty={!data || data.rows.length === 0}
          onRetry={() => { void refetch(); }}
          emptyTitle="Nothing here yet — once you log a transfer, lock a daily book, or save a batch you'll see it."
        />
        {data && data.rows.length > 0 && (
          <>
            <AuditTable rows={data.rows} who="store" />
            <Pager
              page={data.page}
              totalPages={data.total_pages}
              onPage={(p) => setParam("page", String(p))}
            />
          </>
        )}
      </Card>

    </PageShell>
  );
}
