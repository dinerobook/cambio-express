// Open settlements of one kind as of the day being viewed — shared by
// the settlement tiles and the Check Deposits box's on-hold pill.
// Kept out of DailyBookSettlements.tsx so that file exports only
// components (fast refresh).

import { useOpenSettlements, type OpenSettlement } from "../api/dailybook";
import { todayIso } from "../lib/datetime";

export function isOverdue(o: OpenSettlement, today: string): boolean {
  return o.settle_by != null && o.settle_by < today;
}

/** Open entries of `kind` up to the viewed `date`: a return is booked
 *  on that day, so entries made after it are left out (a return
 *  can't predate what it settles). */
export function useOpenOfKind(kind: string, date: string) {
  const query = useOpenSettlements();
  const today = todayIso();
  const items = (query.data ?? []).filter(
    (o) => o.kind === kind && o.report_date <= date,
  );
  return {
    query,
    items,
    total: items.reduce((s, o) => s + o.outstanding, 0),
    overdue: items.filter((o) => isOverdue(o, today)).length,
  };
}
