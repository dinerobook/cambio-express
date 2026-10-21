import { useLocation } from "react-router-dom";

import { getCurrentIdentity } from "../lib/auth";
import { Breadcrumbs } from "./ui";
import { filterNavForRole, navTrail, type NavCrumb } from "./navConfig";

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
  const { pathname } = useLocation();
  const identity = getCurrentIdentity();
  // Module flags only hide items; they never change which item a
  // URL sits under, so the trail does not wait on session-status.
  const groups = filterNavForRole(
    identity?.role ?? "",
    identity?.permissions ?? [],
  );
  const crumbs = [...navTrail(under ?? pathname, groups), ...via];
  if (current) crumbs.push({ label: current });
  return <Breadcrumbs crumbs={crumbs} />;
}
