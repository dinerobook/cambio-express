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
