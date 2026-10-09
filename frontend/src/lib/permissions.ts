import { getCurrentIdentity } from "./auth";
import { hasPermissionWith } from "./access";

/**
 * Check if the current user has a specific granular permission.
 * Returns true if the permission is in the JWT perms claim,
 * or if the user is superadmin (always has everything).
 *
 * For "can they open this page" questions, prefer `canAccess(to)`
 * from `./access` — it reads the same route table the router and
 * the link primitives use, so a control and its destination cannot
 * disagree.
 */
export function hasPermission(resource: string, action: string): boolean {
  return hasPermissionWith(getCurrentIdentity(), resource, action);
}

/**
 * Resources that are one on/off switch rather than an area with
 * create / view / edit / delete — the twin of the server's
 * `RBAC_RESOURCE_ACTIONS`. `day_lock` ("Lock / unlock days") is
 * stored as its `update` action; the grid shows that one box and
 * nothing else on the row.
 */
export const RESOURCE_ACTIONS: Record<string, string[]> = {
  day_lock: ["update"],
};

/** The actions `resource` has, in the order `actions` lists them. */
export function actionsFor(resource: string, actions: string[]): string[] {
  const only = RESOURCE_ACTIONS[resource];
  return only ? actions.filter((a) => only.includes(a)) : actions;
}

/**
 * Flip one cell of a permission-matrix row, keeping the row
 * coherent: any write (create / update / delete) needs View, so
 * ticking a write ticks View and unticking View clears the writes.
 * Without this, "Edit but not View" opened a page's editor while
 * the page's own list / calendar bounced to the dashboard. The
 * server applies the same rule (`_with_implied_read`), so the
 * boxes show what is enforced. A single-switch resource
 * (`RESOURCE_ACTIONS`) has no View, so nothing is implied there.
 * Every matrix editor goes through this — never flip a cell by hand.
 */
export function toggleMatrixCell(
  row: Record<string, boolean> | undefined,
  action: string,
  resource = "",
): Record<string, boolean> {
  const next = { ...(row ?? {}) };
  const on = !next[action];
  next[action] = on;
  if (RESOURCE_ACTIONS[resource]) return next;
  if (action === "read" && !on) {
    for (const a of Object.keys(next)) next[a] = false;
  } else if (action !== "read" && on) {
    next.read = true;
  }
  return next;
}

/** Human label for a login's account type. "owner" is the
 *  signup account that owns the store; it is shown but never
 *  managed from the team pages (the rank rule). */
export function accountTypeLabel(role: string | null | undefined): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Super Admin";
  return "Employee";
}
