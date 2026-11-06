import type { AdminAuditRow } from "../api/admin";
import { csvTimestamp, formatTimestamp } from "../lib/datetime";
import { DataTable, type DataColumn, type DataTableProps } from "./ui";
import { AuditActionBadge } from "./AuditActionBadge";
import styles from "./AuditTable.module.css";
import { auditTargetLabel } from "./auditFilters";
import { t, useT } from "../i18n";
import { roleLabel } from "../api/roles";

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
  | "emptyTitle" | "emptyBody" | "page" | "exportCsv"
>) {
  useT(); // headings follow the language
  return (
    <DataTable
      {...state}
      columns={columnsFor(who)}
      rows={rows}
      // ts + target_id is unique enough; (source, ts) collisions can
      // happen across the same wallclock second, so the row's own
      // position is the final tiebreaker.
      rowKey={(r, i) => `${r.source}-${r.ts}-${r.target_id}-${i}`}
    />
  );
}

// Built during render so the headings follow the language. The CSV
// keeps the stored slugs, so a download reads the same in any language.
function columnsFor(who: "actor" | "store" | "both"): DataColumn<AuditTableRow>[] {
  const WHEN: DataColumn<AuditTableRow> = {
    key: "when", header: t("audit.colWhen"),
    render: (r) => <span className={styles.monoMuted}>{formatTimestamp(r.ts)}</span>,
    csv: (r) => csvTimestamp(r.ts),
  };

  const ACTOR: DataColumn<AuditTableRow> = {
    key: "actor", header: t("audit.colActor"),
    render: (r) => (
      <>
        <strong>{r.user_name || "—"}</strong>
        {r.user_role && <span className={styles.userRole}>({roleLabel(r.user_role)})</span>}
      </>
    ),
    csv: (r) => (r.user_role ? `${r.user_name ?? ""} (${r.user_role})`.trim() : r.user_name),
  };

  const STORE: DataColumn<AuditTableRow> = {
    key: "store", header: t("audit.colStore"), render: (r) => r.store_name || "—",
    csv: (r) => r.store_name,
  };

  const REST: DataColumn<AuditTableRow>[] = [
    { key: "action", header: t("audit.action"), render: (r) => <AuditActionBadge action={r.action} />,
      csv: (r) => r.action },
    {
      key: "target", header: t("audit.target"),
      render: (r) => (
        <span>
          <span className={styles.targetType}>{r.target_type ? auditTargetLabel(r.target_type) : "—"}</span>
          {r.target_label && <span className={styles.targetLabel}>{r.target_label}</span>}
        </span>
      ),
      csv: (r) => [r.target_type, r.target_label].filter(Boolean).join(" "),
    },
    {
      key: "details", header: t("audit.colDetails"),
      render: (r) => <span className={styles.detailCell}>{r.summary || "—"}</span>,
      csv: (r) => r.summary,
    },
  ];

  if (who === "store") return [WHEN, STORE, ...REST];
  if (who === "both") return [WHEN, STORE, ACTOR, ...REST];
  return [WHEN, ACTOR, ...REST];
}
