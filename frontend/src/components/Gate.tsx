import { Navigate, useLocation } from "react-router-dom";

import { canAccessWith, findAccess, homePathFor } from "../lib/access";
import { getCurrentIdentity } from "../lib/auth";

/** Route guard driven by `lib/access.ts`.
 *
 *  Wrap every authed route's element in `<Gate>`; it looks the
 *  current URL up in `ROUTE_ACCESS` and bounces anyone the table
 *  says may not be here. Because the link primitives read the same
 *  table, a person who reaches this bounce clicked nothing we
 *  rendered — a bookmark, a typed URL, or a link from outside.
 *
 *  A route with no entry is refused rather than allowed: the
 *  coverage test in `access.test.ts` should catch that first, but
 *  fail-closed is the right default for a guard. */
export default function Gate({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const identity = getCurrentIdentity();
  if (!identity) return <Navigate to="/login" replace />;
  // Home is the dashboard, or Reports for an accountant (who has
  // no dashboard) — never a page that would bounce again.
  const home = homePathFor(identity);
  if (findAccess(pathname) === undefined) {
    return <Navigate to={home} replace />;
  }
  if (!canAccessWith(identity, pathname)) {
    return <Navigate to={home} replace />;
  }
  return <>{children}</>;
}
