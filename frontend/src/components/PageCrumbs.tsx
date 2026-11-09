import { useLocation } from "react-router-dom";

import { getCurrentIdentity } from "../lib/auth";
import { Breadcrumbs } from "./ui";
import {
  CHECK_HOME, filterNavForRole, navTrail, workspaceForPath, type NavCrumb,
} from "./navConfig";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

/** The trail above every page title (UI-STANDARDS §7b). The first
 *  crumbs come from the sidebar (`NAV`), never typed by hand, so a
 *  page carries ONE name: its sidebar label is its trail crumb and
 *  its title.
 *
 *  - A sidebar page: `<PageCrumbs />` → "Money services / Transfers".
 *  - A page under one: `<PageCrumbs current={`Transfer #${id}`} />`
 *    → "Money services / Transfers / Transfer #12" (the sidebar
 *    item whose route prefixes this URL becomes a link).
 *  - A page the sidebar does not list: name the sidebar page it
 *    hangs off with `under`, and any pages in between with `via`:
 *    `<PageCrumbs under="/reports" via={[{ label: "Monthly P&L",
 *    to: "/monthly" }]} current="Categories" />`. */
export function PageCrumbs({
  current, under, via = [],
}: {
  current?: string;
  under?: string;
  via?: NavCrumb[];
}) {
  useT(); // re-render when the language changes
  const { pathname } = useLocation();
  const identity = getCurrentIdentity();
  // Module flags only hide items; they never change which item a
  // URL sits under, so the trail does not wait on session-status.
  const path = under ?? pathname;
  // A check cashing page sits under that app's sidebar, and its
  // trail starts with the app's name: "Check cashing / Customers".
  const checks = workspaceForPath(path) === "checks";
  const groups = filterNavForRole(
    identity?.role ?? "",
    identity?.permissions ?? [],
    undefined,
    checks ? "checks" : "backoffice",
  );
  // Sidebar crumbs read in the person's language like the sidebar
  // itself; `via` and `current` arrive already translated.
  const crumbs = [
    ...(checks ? [{ label: navWord("Check cashing"), to: CHECK_HOME }] : []),
    ...navTrail(path, groups)
      .map((c) => ({ ...c, label: navWord(c.label) })),
    ...via,
  ];
  if (current) crumbs.push({ label: current });
  return <Breadcrumbs crumbs={crumbs} />;
}
