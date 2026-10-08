import { Fragment, type ReactNode } from "react";

import { Checkbox } from "./ui";
import styles from "./PermissionMatrixTable.module.css";

// Single source of truth for permission-matrix labels — every
// route that renders the resources × actions grid goes through
// these (StorePermissions, OwnerStorePermissions,
// SuperadminPermissions, SuperadminStoreDrill, AdminUserForm,
// OwnerBulkPermissions, RoleEdit, RolesAccess).
/* eslint-disable react-refresh/only-export-components -- the label
   maps are the component's default labelers; exporting them here
   keeps one import path for the matrix + its vocabulary.  Fast-
   refresh skip on this single file is acceptable. */
export const RESOURCE_LABELS: Record<string, string> = {
  transfers: "Money transfers",
  customers: "Customers",
  daily_book: "MSB Daily book",
  monthly: "Monthly P&L",
  batches: "ACH batches",
  bank_sync: "Bank sync",
  reports: "Reports",
  settings: "Settings",
  // Both rows live under the sidebar's Team menu; the labels say
  // so, so taking one away doesn't read as "removes Team" while
  // the other still shows it.
  users: "Team: employees & logins",
  time_clock: "Team: time clock",
  return_checks: "Returned checks",
  lottery: "Lottery",
  day_close: "Store daily book",
  catalog: "Price book & purchases",
};

export const ACTION_LABELS: Record<string, string> = {
  create: "Create", read: "View", update: "Edit", delete: "Delete",
};

/** Areas grouped the way the sidebar groups their pages, so a
 *  long grid reads in sections instead of one undivided list.
 *  A resource missing here still renders, under "Other". */
export const RESOURCE_GROUPS: { title: string; resources: string[] }[] = [
  {
    title: "Money services",
    resources: ["transfers", "customers", "batches", "return_checks"],
  },
  {
    title: "Books",
    resources: ["daily_book", "day_close", "monthly", "lottery", "catalog"],
  },
  { title: "Finance", resources: ["bank_sync", "reports"] },
  { title: "Team", resources: ["users", "time_clock"] },
  { title: "Store", resources: ["settings"] },
];

/** Split `resources` into RESOURCE_GROUPS order, dropping empty
 *  groups and keeping anything unmapped visible under "Other". */
export function groupResources(
  resources: string[],
): { title: string; resources: string[] }[] {
  const known = new Set(RESOURCE_GROUPS.flatMap((g) => g.resources));
  const out = RESOURCE_GROUPS
    .map((g) => ({
      title: g.title,
      resources: g.resources.filter((r) => resources.includes(r)),
    }))
    .filter((g) => g.resources.length > 0);
  const other = resources.filter((r) => !known.has(r));
  if (other.length) out.push({ title: "Other", resources: other });
  return out;
}
/* eslint-enable react-refresh/only-export-components */

const defaultResourceLabel = (r: string) => RESOURCE_LABELS[r] ?? r;
const defaultActionLabel = (a: string) => ACTION_LABELS[a] ?? a;

/** Resources × actions checkbox grid — THE permission matrix.
 *  One shared rendering for every permissions surface (see
 *  UI-STANDARDS.md §5). The component owns the overflow wrapper,
 *  the table markup and the cell checkboxes; callers supply the
 *  axes plus `checked` / `onToggle` accessors scoped to whatever
 *  entity (role, user) the surrounding card represents.
 */
export function PermissionMatrixTable({
  resources,
  actions,
  checked,
  onToggle,
  disabled = false,
  resourceLabel = defaultResourceLabel,
  actionLabel = defaultActionLabel,
  resourceHeader = "Resource",
  ariaContext,
  trailingColumn,
  grouped = false,
}: {
  resources: string[];
  actions: string[];
  /** Is the (resource, action) cell checked? */
  checked: (resource: string, action: string) => boolean;
  onToggle: (resource: string, action: string) => void;
  disabled?: boolean;
  resourceLabel?: (resource: string) => string;
  actionLabel?: (action: string) => string;
  /** First-column header text (default "Resource"). */
  resourceHeader?: string;
  /** Appended to each cell's aria-label, e.g. the role the
   *  surrounding card edits: `View — Reports (admin)`. */
  ariaContext?: string;
  /** Optional extra column after the action columns (e.g. the
   *  per-resource "all actions" checkbox on SuperadminPermissions).
   *  The rendered node is centered inside the cell. */
  trailingColumn?: {
    header: ReactNode;
    render: (resource: string) => ReactNode;
  };
  /** Insert a section header row before each RESOURCE_GROUPS
   *  group (Money services, Books…). */
  grouped?: boolean;
}) {
  const context = ariaContext ? ` (${ariaContext})` : "";
  const span = 1 + actions.length + (trailingColumn ? 1 : 0);
  const sections = grouped
    ? groupResources(resources)
    : [{ title: "", resources }];
  return (
    <div className={styles.scroll}>
      <table className={styles.matrix}>
        <thead>
          <tr>
            <th>{resourceHeader}</th>
            {actions.map((a) => <th key={a}>{actionLabel(a)}</th>)}
            {trailingColumn && <th>{trailingColumn.header}</th>}
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <Fragment key={section.title || "all"}>
              {section.title && (
                <tr className={styles.groupRow}>
                  <td colSpan={span}>{section.title}</td>
                </tr>
              )}
              {section.resources.map((resource) => (
                <tr key={resource}>
                  <td>{resourceLabel(resource)}</td>
                  {actions.map((action) => (
                    <td key={action}>
                      <div className={styles.checkCell}>
                        <Checkbox
                          checked={checked(resource, action)}
                          onChange={() => onToggle(resource, action)}
                          disabled={disabled}
                          aria-label={`${actionLabel(action)} — ${resourceLabel(resource)}${context}`}
                        />
                      </div>
                    </td>
                  ))}
                  {trailingColumn && (
                    <td>
                      <div className={styles.checkCell}>
                        {trailingColumn.render(resource)}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
