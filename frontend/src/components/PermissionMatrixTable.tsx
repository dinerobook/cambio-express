import { Fragment, type ReactNode } from "react";

import { actionsFor } from "../lib/permissions";
import { Checkbox } from "./ui";
import { t, useT, type MessageKey } from "../i18n";
import styles from "./PermissionMatrixTable.module.css";

// Single source of truth for permission-matrix labels — every
// route that renders the resources × actions grid goes through
// these (StorePermissions, OwnerStorePermissions,
// SuperadminPermissions, SuperadminStoreDrill, AdminUserForm,
// OwnerBulkPermissions, RoleEdit, RolesAccess). The tables hold
// translator keys (UI-STANDARDS §10); screens show the words through
// `resourceLabel()` / `actionLabel()` / `actionShort()`, and an
// unknown resource or action shows as stored.
/* eslint-disable react-refresh/only-export-components -- the label
   maps are the component's default labelers; exporting them here
   keeps one import path for the matrix + its vocabulary.  Fast-
   refresh skip on this single file is acceptable. */
export const RESOURCE_LABELS: Record<string, MessageKey> = {
  transfers: "perm.resTransfers",
  customers: "perm.resCustomers",
  daily_book: "perm.resDailyBook",
  monthly: "perm.resMonthly",
  batches: "perm.resBatches",
  bank_sync: "perm.resBankSync",
  reports: "perm.resReports",
  settings: "perm.resSettings",
  // Both rows live under the sidebar's Team menu; the labels say
  // so, so taking one away doesn't read as "removes Team" while
  // the other still shows it.
  users: "perm.resUsers",
  time_clock: "perm.resTimeClock",
  return_checks: "perm.resReturnChecks",
  lottery: "perm.resLottery",
  day_close: "perm.resDayClose",
  catalog: "perm.resCatalog",
  // One switch for both daily books' Lock / Unlock buttons. Only
  // bites alongside Edit on that book.
  day_lock: "perm.resDayLock",
  // One switch: mark bank transactions as already handled.
  bank_dismiss: "perm.resBankDismiss",
};

export const ACTION_LABELS: Record<string, MessageKey> = {
  create: "perm.actCreate", read: "perm.actRead",
  update: "perm.actUpdate", delete: "perm.actDelete",
};

/** One letter per action for the compact "Access by area" chips.
 *  Its own key, because the first letters collide in Spanish
 *  (Editar / Eliminar). */
const ACTION_SHORT: Record<string, MessageKey> = {
  create: "perm.actCreateShort", read: "perm.actReadShort",
  update: "perm.actUpdateShort", delete: "perm.actDeleteShort",
};

export function resourceLabel(resource: string): string {
  return Object.hasOwn(RESOURCE_LABELS, resource)
    ? t(RESOURCE_LABELS[resource]) : resource;
}

export function actionLabel(action: string): string {
  return Object.hasOwn(ACTION_LABELS, action) ? t(ACTION_LABELS[action]) : action;
}

export function actionShort(action: string): string {
  return Object.hasOwn(ACTION_SHORT, action)
    ? t(ACTION_SHORT[action]) : action.charAt(0).toUpperCase();
}

/** Areas grouped the way the sidebar groups their pages, so a
 *  long grid reads in sections instead of one undivided list.
 *  A resource missing here still renders, under "Other". `title`
 *  is a translator key. */
export const RESOURCE_GROUPS: { title: MessageKey; resources: string[] }[] = [
  {
    title: "perm.groupMoneyServices",
    resources: ["transfers", "customers", "batches", "return_checks"],
  },
  {
    title: "perm.groupBooks",
    resources: [
      "daily_book", "day_close", "day_lock", "monthly", "lottery", "catalog",
    ],
  },
  { title: "perm.groupFinance", resources: ["bank_sync", "bank_dismiss", "reports"] },
  { title: "perm.groupTeam", resources: ["users", "time_clock"] },
  { title: "perm.groupStore", resources: ["settings"] },
];

/** Split `resources` into RESOURCE_GROUPS order, dropping empty
 *  groups and keeping anything unmapped visible under "Other".
 *  `key` is stable across languages; `title` is in the person's. */
export function groupResources(
  resources: string[],
): { key: string; title: string; resources: string[] }[] {
  const known = new Set(RESOURCE_GROUPS.flatMap((g) => g.resources));
  const out: { key: string; title: string; resources: string[] }[] = RESOURCE_GROUPS
    .map((g) => ({
      key: g.title,
      title: t(g.title),
      resources: g.resources.filter((r) => resources.includes(r)),
    }))
    .filter((g) => g.resources.length > 0);
  const other = resources.filter((r) => !known.has(r));
  if (other.length) out.push({ key: "other", title: t("perm.groupOther"), resources: other });
  return out;
}
/* eslint-enable react-refresh/only-export-components */

/** Resources × actions checkbox grid — THE permission matrix.
 *  A single-switch resource (`RESOURCE_ACTIONS`, e.g. "Lock /
 *  unlock days") shows only its one box; its other cells are empty.
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
  resourceLabel: labelResource = resourceLabel,
  actionLabel: labelAction = actionLabel,
  resourceHeader,
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
  useT(); // re-render on a language switch
  const context = ariaContext ? ` (${ariaContext})` : "";
  const span = 1 + actions.length + (trailingColumn ? 1 : 0);
  const sections = grouped
    ? groupResources(resources)
    : [{ key: "all", title: "", resources }];
  return (
    <div className={styles.scroll}>
      <table className={styles.matrix}>
        <thead>
          <tr>
            <th>{resourceHeader ?? t("perm.resource")}</th>
            {actions.map((a) => <th key={a}>{labelAction(a)}</th>)}
            {trailingColumn && <th>{trailingColumn.header}</th>}
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <Fragment key={section.key}>
              {section.title && (
                <tr className={styles.groupRow}>
                  <td colSpan={span}>{section.title}</td>
                </tr>
              )}
              {section.resources.map((resource) => (
                <tr key={resource}>
                  <td>{labelResource(resource)}</td>
                  {actions.map((action) => (
                    <td key={action}>
                      {actionsFor(resource, actions).includes(action) && (
                        <div className={styles.checkCell}>
                          <Checkbox
                            checked={checked(resource, action)}
                            onChange={() => onToggle(resource, action)}
                            disabled={disabled}
                            aria-label={`${labelAction(action)} — ${labelResource(resource)}${context}`}
                          />
                        </div>
                      )}
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
