import type { AdminAuditRow } from "../api/admin";
import { formatTimestamp } from "../lib/datetime";
import { DataTable, type DataColumn, type DataTableProps } from "./ui";
import { AuditActionBadge } from "./AuditActionBadge";
import styles from "./AuditTable.module.css";

/** One audit row as the table reads it. The store feeds
 *  (`Admin.Services.audit_log.list_audit_rows`) fill `user_*`; the
 *  per-person feed ("My activity") fills `store_name` instead. */
export type AuditTableRow =
  Omit<AdminAuditRow, "user_name" | "user_role"> & {
    user_name?: string;
    user_role?: string;
    store_name?: string;
  };

/** An audit feed as a table: When · Actor/Store · Action · Target ·
 *  Details. Shared by the store admin's Audit log, the superadmin
 *  store page's Activity section, the platform audit log and the
 *  per-person "My activity" page, so the columns, the timestamp
 *  rendering and the action badge live here once.
 *
 *  `who` picks the second column: `"actor"` (default) — who did it,
 *  for a feed about one store; `"store"` — where it happened, for a
 *  feed about one person across stores; `"both"` — store and actor,
 *  for an owner's feed across their stores.
 *
 *  Rows written while a superadmin was signed in as someone carry
 *  "(via superadmin …)" inside `user_name`; nothing to do here.
 *
 *  Built on the kit ``<DataTable>``: pass the query's state and the
 *  ``page`` slice and the skeleton, error, empty state and pager come
 *  with it. */
export function AuditTable({
  rows, who = "actor", ...state
}: {
  rows: AuditTableRow[] | undefined;
  who?: "actor" | "store" | "both";
} & Pick<
  DataTableProps<AuditTableRow>,
  | "isLoading" | "isError" | "error" | "onRetry" | "errorMessage"
  | "emptyTitle" | "emptyBody" | "page"
>) {
  return (
    <DataTable
      {...state}
      columns={COLUMNS[who]}
      rows={rows}
      // ts + target_id is unique enough; (source, ts) collisions can
      // happen across the same wallclock second, so the row's own
      // position is the final tiebreaker.
      rowKey={(r, i) => `${r.source}-${r.ts}-${r.target_id}-${i}`}
    />
  );
}

const WHEN: DataColumn<AuditTableRow> = {
  key: "when", header: "When",
  render: (r) => <span className={styles.monoMuted}>{formatTimestamp(r.ts)}</span>,
};

const ACTOR: DataColumn<AuditTableRow> = {
  key: "actor", header: "Actor",
  render: (r) => (
    <>
      <strong>{r.user_name || "—"}</strong>
      {r.user_role && <span className={styles.userRole}>({r.user_role})</span>}
    </>
  ),
};

const STORE: DataColumn<AuditTableRow> = {
  key: "store", header: "Store", render: (r) => r.store_name || "—",
};

const REST: DataColumn<AuditTableRow>[] = [
  { key: "action", header: "Action", render: (r) => <AuditActionBadge action={r.action} /> },
  {
    key: "target", header: "Target",
    render: (r) => (
      <span>
        <span className={styles.targetType}>{r.target_type || "—"}</span>
        {r.target_label && <span className={styles.targetLabel}>{r.target_label}</span>}
      </span>
    ),
  },
  {
    key: "details", header: "Details",
    render: (r) => <span className={styles.detailCell}>{r.summary || "—"}</span>,
  },
];

const COLUMNS = {
  actor: [WHEN, ACTOR, ...REST],
  store: [WHEN, STORE, ...REST],
  both: [WHEN, STORE, ACTOR, ...REST],
};
