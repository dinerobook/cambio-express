// Tab model for the employee form (E-3). Kept beside the route
// as a pure module (same pattern as editDailyBook.totals.ts) so
// the resolution rules are unit-testable without mounting the
// whole form.

import type { MessageKey } from "../i18n";

/** `label` is a translator key; the form shows `t(label)`. */
export const EMPLOYEE_TABS = [
  { key: "profile", label: "employee.tabProfile" },
  { key: "payroll", label: "employee.tabPayroll" },
  { key: "login",   label: "employee.tabLogin" },
] as const satisfies readonly { key: string; label: MessageKey }[];

export type EmployeeTabKey = (typeof EMPLOYEE_TABS)[number]["key"];

export function isEmployeeTabKey(v: string | null): v is EmployeeTabKey {
  return EMPLOYEE_TABS.some((t) => t.key === v);
}

/** Which tabs a given form instance shows. A person who hasn't
 *  been created yet has no record to attach a login to, so the
 *  Login tab only exists in edit mode. */
export function visibleEmployeeTabs(isEdit: boolean) {
  return EMPLOYEE_TABS.filter((t) => isEdit || t.key !== "login");
}

/** Resolve `?tab=` to the tab actually rendered.
 *
 *  Falls back to "profile" for a missing, misspelled, or
 *  hand-edited value, and for "login" on an unsaved employee —
 *  a deep link that outlives its target must not render an empty
 *  page. */
export function resolveEmployeeTab(
  raw: string | null, isEdit: boolean,
): EmployeeTabKey {
  if (!isEmployeeTabKey(raw)) return "profile";
  if (raw === "login" && !isEdit) return "profile";
  return raw;
}
