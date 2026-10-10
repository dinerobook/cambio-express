import type { AdminAuditRow } from "../api/admin";
import { formatTimestamp } from "../lib/datetime";
import { Table, tdStyle, thStyle } from "./ui";
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
 *  feed about one person across stores.
 *
 *  Rows written while a superadmin was signed in as someone carry
 *  "(via superadmin …)" inside `user_name`; nothing to do here. */
export function AuditTable({
  rows, who = "actor",
}: {
  rows: AuditTableRow[];
  who?: "actor" | "store";
}) {
  return (
    <Table>
      <thead>
        <tr>
          {["When", who === "store" ? "Store" : "Actor", "Action", "Target", "Details"].map((h) => (
            <th key={h} style={thStyle}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          // ts + target_id is unique enough; (source, ts) collisions
          // can happen across the same wallclock second so we add
          // the index as the final tiebreaker.
          <tr key={`${r.source}-${r.ts}-${r.target_id}-${i}`}>
            <td style={tdStyle}>
              <span className={styles.monoMuted}>
                {formatTimestamp(r.ts)}
              </span>
            </td>
            {who === "store" ? (
              <td style={tdStyle}>{r.store_name || "—"}</td>
            ) : (
              <td style={tdStyle}>
                <strong>{r.user_name || "—"}</strong>
                {r.user_role && (
                  <span className={styles.userRole}>
                    ({r.user_role})
                  </span>
                )}
              </td>
            )}
            <td style={tdStyle}>
              <AuditActionBadge action={r.action} />
            </td>
            <td style={tdStyle}>
              <span className={styles.targetType}>
                {r.target_type || "—"}
              </span>
              {r.target_label && <div>{r.target_label}</div>}
            </td>
            <td style={{ ...tdStyle }} className={styles.detailCell}>
              {r.summary || "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
