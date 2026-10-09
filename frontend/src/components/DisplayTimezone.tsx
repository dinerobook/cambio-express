import { Fragment } from "react";

import { getDisplayTimezone, setDisplayTimezone } from "../lib/datetime";

/** Points every date / time helper in lib/datetime at the store's
 *  timezone (session-status `timezone`) for the page below it.
 *
 *  Set during render, before the page renders in the same pass, so
 *  the first paint already reads the right zone. The page is keyed
 *  on the zone: the helpers are plain functions, not hooks, so a
 *  zone change (first load on a new device, an admin saving a new
 *  timezone) re-mounts the page instead of leaving stale times on
 *  screen. `undefined` (session-status still loading) keeps the
 *  last known zone, which lib/datetime restores per device. */
export function DisplayTimezone({
  timezone, children,
}: {
  timezone: string | undefined;
  children: React.ReactNode;
}) {
  if (timezone !== undefined) setDisplayTimezone(timezone);
  return <Fragment key={getDisplayTimezone() ?? ""}>{children}</Fragment>;
}
