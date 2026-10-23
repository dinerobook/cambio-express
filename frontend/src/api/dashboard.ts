// Dashboard summary client. Hits /api/v2/dashboard/summary,
// which returns a role-shaped payload — the route component
// branches on `role` and the TS discriminated union below
// narrows the payload accordingly.

import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import type { components } from "./openapi";

type Schemas = components["schemas"];

// One shape per role; `role` narrows the union. Module blocks are
// null when the module is off or nothing is recorded yet.
export type AdminDashboardKpis = Schemas["AdminDashboardKpis"];
export type CompanyStat = Schemas["CompanyStat"];
export type DashboardTransferRow = Schemas["DashboardTransferRow"];
export type DashboardBatchRow = Schemas["DashboardBatchRow"];
export type DashboardBankAccount = Schemas["DashboardBankAccount"];
export type DayCloseSnapshot = Schemas["DayCloseSnapshot"];
export type LotterySnapshot = Schemas["LotterySnapshot"];
export type HourlyBlock = Schemas["HourlyBlock"];
export type SalesBlock = Schemas["SalesBlock"];
export type PurchasesBlock = Schemas["PurchasesBlock"];
export type RegisterActivityBlock = Schemas["RegisterActivityBlock"];
export type ReceiptRow = Schemas["ReceiptRow"];
export type TransfersRollup = Schemas["TransfersRollup"];
export type ClockedInRow = Schemas["ClockedInRow"];
export type AdminDashboard = Schemas["AdminDashboard"];
export type EmployeeTodayRow = Schemas["EmployeeTodayRow"];
export type EmployeeDashboard = Schemas["EmployeeDashboard"];

/** The platform context: wide and loosely shaped, the page reads the
 *  handful of keys it needs. */
export type SuperadminDashboard = Schemas["SuperadminDashboard"];

export type DashboardSummary =
  | AdminDashboard
  | EmployeeDashboard
  | SuperadminDashboard;

export function useDashboardSummary() {
  // Owners have no store_id on their JWT — /api/v2/dashboard/summary
  // 400s for them. The Dashboard route component <Navigate>s them
  // away, but the hook still mounts before that branch returns, so
  // we gate the fetch here too. Belt-and-suspenders against the
  // Rules of Hooks ordering.
  const identity = getCurrentIdentity();
  const enabled =
    identity != null && !["owner", "support"].includes(identity.role);
  return useQuery<DashboardSummary>({
    enabled,
    queryKey: ["dashboard", "summary"],
    queryFn: async () =>
      api<DashboardSummary>("/api/v2/dashboard/summary"),
  });
}
