import type { AdminAuditRow } from "../api/admin";
import { formatTimestamp } from "../lib/datetime";
import { Table, tdStyle, thStyle } from "./ui";
import { AuditActionBadge } from "./AuditActionBadge";
import styles from "./AuditTable.module.css";

/** One store's merged operator + transfer audit feed as a table.
 *  Shared by the store admin's Audit log page and the superadmin
 *  store page's Activity section — both read the same row shape
 *  (`Admin.Services.audit_log.list_audit_rows`), so the columns,
 *  the timestamp rendering and the action badge live here once.
 *
 *  Rows written while a superadmin was signed in as someone carry
 *  "(via superadmin …)" inside `user_name`; nothing to do here. */
export function AuditTable({
  rows, userTimezone, storeTimezone,
}: {
  rows: AdminAuditRow[];
  /** The viewer's timezone (profile) — blank falls back to the
   *  store's, then the browser's. */
  userTimezone: string;
  storeTimezone: string;
}) {
  return (
    <Table>
      <thead>
        <tr>
          {["When", "Actor", "Action", "Target", "Details"].map((h) => (
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
                {formatTimestamp(r.ts, { userTimezone, storeTimezone })}
              </span>
            </td>
            <td style={tdStyle}>
              <strong>{r.user_name || "—"}</strong>
              {r.user_role && (
                <span className={styles.userRole}>
                  ({r.user_role})
                </span>
              )}
            </td>
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
