// Which app a person is working in: the back office or check cashing
// (navConfig "Workspaces", UI-STANDARDS §8). The URL decides the view;
// this file answers who gets the switch, who has nothing but check
// cashing, and remembers each person's last view on this device so
// they open where they left off.

import { findAccess } from "./access";
import {
  CHECK_DESK_FLAG, filterNavForRole, workspaceForPath, type Workspace,
} from "../components/navConfig";

/** The store has check cashing switched on and this person may open
 *  at least one of its pages. */
export function checksAvailable(
  role: string, permissions: string[], features: string[] | undefined,
): boolean {
  if (!features?.includes(CHECK_DESK_FLAG)) return false;
  return filterNavForRole(role, permissions, features, "checks").length > 0;
}

/** This person can do something in the back office beyond the pages
 *  everyone signed in gets (the dashboard). Someone who may only cash
 *  checks never needs the switch: they always work in check cashing. */
export function hasBackOffice(
  role: string, permissions: string[], features: string[] | undefined,
): boolean {
  return filterNavForRole(role, permissions, features, "backoffice").some((g) =>
    [...(g.to ? [g.to] : []), ...g.items.map((i) => i.to)]
      .some((to) => !findAccess(to)?.open));
}

const key = (userId: number) => `db.workspace.${userId}`;

export function rememberedWorkspace(userId: number | undefined): Workspace | null {
  if (userId == null) return null;
  try {
    const v = window.localStorage.getItem(key(userId));
    return v === "checks" || v === "backoffice" ? v : null;
  } catch {
    return null;
  }
}

export function rememberWorkspace(userId: number | undefined, w: Workspace): void {
  if (userId == null) return;
  try {
    window.localStorage.setItem(key(userId), w);
  } catch {
    /* no storage (private window): the view just is not remembered */
  }
}

// Once per browser tab: the first page after sign-in may send the
// person to the view they used last. Later visits to the dashboard
// are on purpose and stay put.
const LANDED = "db.workspace.landed";

export function takeFirstLanding(): boolean {
  try {
    if (window.sessionStorage.getItem(LANDED)) return false;
    window.sessionStorage.setItem(LANDED, "1");
    return true;
  } catch {
    return false;
  }
}

/** Sign-out: the next person to sign in on this tab gets their own
 *  first landing. */
export function resetFirstLanding(): void {
  try {
    window.sessionStorage.removeItem(LANDED);
  } catch {
    /* nothing stored */
  }
}

/** The view to show for `path`: the URL's own app, else (a personal
 *  page) the last one used; never check cashing when it is not
 *  available, and always check cashing for someone with no back
 *  office. */
export function workspaceFor(
  path: string,
  { available, backOffice, remembered }: {
    available: boolean; backOffice: boolean; remembered: Workspace | null;
  },
): Workspace {
  if (!available) return "backoffice";
  if (!backOffice) return "checks";
  return workspaceForPath(path) ?? remembered ?? "backoffice";
}
