import { matchPath } from "react-router-dom";

import { getCurrentIdentity, type IdentityClaims } from "./auth";

/**
 * Route access — the ONE place that says who may reach each SPA
 * route.
 *
 * The rule this file exists to enforce: **no access, no control.**
 * If a person cannot open a page, they must not see the tab, link,
 * button, or row action that leads there — not an empty tab, not a
 * button that bounces them to the dashboard. That only stays true
 * when the router guard and every control that points at the route
 * read the same answer, so:
 *
 *   - `App.tsx` wraps every authed route in `<Gate>`, which looks the
 *     current path up here.
 *   - `ButtonLink`, `TabsLink` and `AppLink` (the kit's link
 *     primitives) render nothing when `canAccess(to)` is false.
 *   - `filterNavForRole` in `navConfig.tsx` uses `canAccessWith` for
 *     the sidebar and section hubs.
 *   - `Button perm=` and `RowActions` items with `perm:` hide
 *     themselves for in-page actions that are not links.
 *
 * `access.test.ts` walks `App.tsx` and fails when a route under the
 * authed shell has no entry here, so a new page cannot ship
 * unmapped.
 *
 * Semantics:
 *   - `perm`  — "resource.action"; superadmin always passes.
 *   - `roles` — exact list, NO superadmin bypass. List superadmin
 *               explicitly where they should get through (owner
 *               routes, for support). This is deliberate: some
 *               surfaces (store billing) are wrong for superadmin
 *               even though they hold every permission.
 *   - `open`  — any signed-in user.
 *   First matching entry wins, so put the more specific pattern
 *   first (`/superadmin/tickets` before `/superadmin/*`).
 */
export interface RouteAccess {
  /** React Router pattern, leading slash, no `/app` basename. */
  path: string;
  perm?: string;
  roles?: string[];
  open?: true;
}

const STORE_ROLES = ["admin", "employee", "owner"];
const STORE_MANAGERS = ["admin", "owner", "superadmin"];

export const ROUTE_ACCESS: RouteAccess[] = [
  // ── Landing + hubs ─────────────────────────────────────────
  { path: "/dashboard", open: true },
  { path: "/hub/:key", open: true },

  // ── Money services ─────────────────────────────────────────
  { path: "/transfers", perm: "transfers.read" },
  { path: "/transfers/new", perm: "transfers.create" },
  { path: "/transfers/:id", perm: "transfers.read" },
  { path: "/transfers/:id/edit", perm: "transfers.update" },
  { path: "/customers", perm: "customers.read" },
  { path: "/batches", perm: "batches.read" },
  { path: "/batches/new", perm: "batches.create" },
  { path: "/batches/:id/edit", perm: "batches.update" },
  { path: "/return-checks", perm: "return_checks.read" },
  { path: "/return-checks/new", perm: "return_checks.create" },
  { path: "/return-checks/:id/edit", perm: "return_checks.update" },

  // ── MSB books ──────────────────────────────────────────────
  { path: "/daily", perm: "daily_book.read" },
  { path: "/daily/edit", perm: "daily_book.update" },
  { path: "/monthly", perm: "monthly.read" },
  { path: "/monthly/edit", perm: "monthly.update" },

  // ── Store (retail) books ───────────────────────────────────
  { path: "/store-book", perm: "day_close.read" },
  { path: "/store-book/day", perm: "day_close.read" },
  { path: "/pos-import", perm: "day_close.update" },
  { path: "/transactions", perm: "day_close.read" },
  { path: "/transactions/:id", perm: "day_close.read" },
  { path: "/lottery", perm: "lottery.read" },
  { path: "/price-book", perm: "catalog.read" },
  { path: "/purchase-invoices", perm: "catalog.read" },
  { path: "/purchase-invoices/new", perm: "catalog.update" },
  { path: "/purchase-invoices/:id", perm: "catalog.update" },

  // ── Reports ────────────────────────────────────────────────
  { path: "/reports", perm: "reports.read" },
  { path: "/reports/*", perm: "reports.read" },
  { path: "/store-reports", perm: "reports.read" },
  { path: "/store-reports/*", perm: "reports.read" },
  { path: "/admin/data-export", perm: "reports.read" },
  { path: "/admin/audit-log", perm: "reports.read" },

  // ── Finance ────────────────────────────────────────────────
  { path: "/bank", perm: "bank_sync.read" },
  { path: "/bank/rules", perm: "bank_sync.read" },
  { path: "/bank-transactions", perm: "bank_sync.read" },

  // ── Team ───────────────────────────────────────────────────
  // Punching in is every employee's; the payroll / schedule /
  // credential surfaces are management-only even though they share
  // the time_clock.read right (employees hold it to punch).
  { path: "/timeclock", perm: "time_clock.read" },
  { path: "/admin/timeclock", perm: "time_clock.read", roles: STORE_MANAGERS },
  { path: "/admin/timeclock/*", perm: "time_clock.read", roles: STORE_MANAGERS },
  { path: "/employees", perm: "users.read" },
  { path: "/employees/new", perm: "users.create" },
  { path: "/employees/:id/edit", perm: "users.update" },
  { path: "/admin/users/new", perm: "users.create" },
  { path: "/admin/users/:uid/edit", perm: "users.update" },
  { path: "/admin/store-permissions", perm: "settings.read" },

  // ── Displays ───────────────────────────────────────────────
  { path: "/tv-display", perm: "settings.read" },
  { path: "/tv-display/*", perm: "settings.read" },

  // ── Settings + billing ─────────────────────────────────────
  // Profile and Security are personal — everyone has them. General
  // is the store's own info (superadmin has no store). Billing is
  // the store admin's alone: an owner pays per store from inside
  // that store (role becomes "admin" there), a superadmin never.
  { path: "/settings", open: true },
  { path: "/settings/profile", open: true },
  { path: "/settings/security", open: true },
  { path: "/settings/general", perm: "settings.read", roles: STORE_ROLES },
  { path: "/settings/billing", perm: "settings.update", roles: ["admin"] },
  { path: "/settings/referrals", perm: "settings.read", roles: ["admin"] },
  { path: "/subscribe", perm: "settings.update", roles: ["admin"] },
  { path: "/subscribe/success", perm: "settings.update", roles: ["admin"] },
  { path: "/admin/subscription", perm: "settings.read", roles: ["admin"] },
  { path: "/account/*", open: true },

  // ── Owner umbrella ─────────────────────────────────────────
  { path: "/owner/*", roles: ["owner", "superadmin"] },

  // ── Platform ───────────────────────────────────────────────
  { path: "/superadmin/tickets", roles: ["superadmin", "support"] },
  { path: "/superadmin/*", roles: ["superadmin"] },
];

/** Normalise a link target to the form the table is keyed on:
 *  no `/app` basename, no query string or hash, leading slash. */
export function normalisePath(to: string): string {
  let p = to.split(/[?#]/, 1)[0] || "/";
  if (p.startsWith("/app/")) p = p.slice(4);
  else if (p === "/app") p = "/";
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

export function findAccess(to: string): RouteAccess | undefined {
  const path = normalisePath(to);
  return ROUTE_ACCESS.find((r) => matchPath({ path: r.path, end: true }, path));
}

export type IdentityLike = Pick<IdentityClaims, "role" | "permissions"> | null;

export function hasPermissionWith(
  identity: IdentityLike, resource: string, action: string,
): boolean {
  if (!identity) return false;
  if (identity.role === "superadmin") return true;
  return identity.permissions.includes(`${resource}.${action}`);
}

/** Pure form — the sidebar filter and tests pass an identity in. */
export function canAccessWith(identity: IdentityLike, to: string): boolean {
  const rule = findAccess(to);
  // Unlisted targets are not gated here (public pages, external
  // paths). The App.tsx coverage test is what keeps authed routes
  // from being unlisted by accident.
  if (!rule) return true;
  if (!identity) return false;
  if (rule.open) return true;
  if (rule.roles && !rule.roles.includes(identity.role)) return false;
  if (rule.perm) {
    const [resource, action] = rule.perm.split(".", 2);
    if (!hasPermissionWith(identity, resource, action)) return false;
  }
  return true;
}

/** Can the signed-in person open `to`? Reads the current identity. */
export function canAccess(to: string): boolean {
  return canAccessWith(getCurrentIdentity(), to);
}

/** "resource.action" form of `hasPermission`, for `perm=` props. */
export function canDo(perm: string): boolean {
  const [resource, action] = perm.split(".", 2);
  return hasPermissionWith(getCurrentIdentity(), resource, action);
}

/** Is this `href` an in-app path the table should gate? External
 *  URLs, API downloads and static files are not routes. */
export function isAppPath(href: string): boolean {
  return (
    href.startsWith("/")
    && !href.startsWith("//")
    && !href.startsWith("/api/")
    && !href.startsWith("/static/")
  );
}
