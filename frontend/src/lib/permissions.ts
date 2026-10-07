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
 * Flip one cell of a permission-matrix row, keeping the row
 * coherent: any write (create / update / delete) needs View, so
 * ticking a write ticks View and unticking View clears the writes.
 * Without this, "Edit but not View" opened a page's editor while
 * the page's own list / calendar bounced to the dashboard. The
 * server applies the same rule (`_with_implied_read`), so the
 * boxes show what is enforced. Every matrix editor goes through
 * this — never flip a cell by hand.
 */
export function toggleMatrixCell(
  row: Record<string, boolean> | undefined,
  action: string,
): Record<string, boolean> {
  const next = { ...(row ?? {}) };
  const on = !next[action];
  next[action] = on;
  if (action === "read" && !on) {
    for (const a of Object.keys(next)) next[a] = false;
  } else if (action !== "read" && on) {
    next.read = true;
  }
  return next;
}
