import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import type { components } from "./openapi";

// Per-store admin endpoints — distinct from `account.ts` (store-info,
// team, passkeys) and `superadmin.ts` (platform-wide). New admin
// Controllers belong here too.

export type AdminAuditRow = components["schemas"]["AdminAuditRow"];

export type AdminAuditUserOption = components["schemas"]["AdminAuditUserOption"];

export type AdminAuditLogResponse = components["schemas"]["AdminAuditLogResponse"];

export function useAdminAuditLog(
  page: number, target: string, action: string, user: string,
  perPage = 50,
) {
  return useQuery<AdminAuditLogResponse>({
    queryKey: ["admin", "audit-log", page, target, action, user, perPage],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set("page", String(page));
      p.set("per_page", String(perPage));
      if (target) p.set("target", target);
      if (action) p.set("action", action);
      if (user)   p.set("user", user);
      return api<AdminAuditLogResponse>(
        `/api/v2/admin/audit-log?${p.toString()}`,
      );
    },
    placeholderData: (prev) => prev,
  });
}


export type ReferralRedemptionRow = components["schemas"]["ReferralRedemptionRow"];

export type ReferralCodeResponse = components["schemas"]["ReferralCodeResponse"];

export function useReferralCode() {
  return useQuery<ReferralCodeResponse>({
    queryKey: ["admin", "referrals"],
    queryFn: () => api<ReferralCodeResponse>("/api/v2/admin/referrals"),
  });
}


// ── Per-store user management ──────────────────────────────

export type AdminUserRow = components["schemas"]["AdminUserRow"];

export type AdminUserListResponse = components["schemas"]["AdminUserListResponse"];

export type AdminUserDetailResponse = components["schemas"]["AdminUserDetailResponse"];

export interface AdminUserCreateBody {
  // Identity (L-2): the person signs in with their email or phone.
  // At least one is required — the API 422s when both are blank.
  // There is no username to type; the server derives and stores it.
  email?:     string;
  phone?:     string;
  password:   string;
  full_name?: string;
  role?:      string;
  module_access?: string[] | null;
  // R-2: custom-access overlay written at creation time.
  // Omitted/null = pure role permissions.
  permissions?: PermMatrix | null;
  // R-3: put the new hire straight into a saved role. Takes
  // precedence over `permissions` server-side — a named role IS a
  // matrix, and honouring both would leave the label describing
  // access the user does not have.
  store_role_id?: number | null;
}

export interface AdminUserUpdateBody {
  full_name?: string;
  role?:      string;
  is_active?: boolean;
  password?:  string;
  // PATCH semantics: omitted = unchanged; null = all modules;
  // a list = restrict to those modules.
  module_access?: string[] | null;
}

export function useAdminUsers() {
  const identity = getCurrentIdentity();
  return useQuery<AdminUserListResponse>({
    enabled: identity?.store_id != null,
    queryKey: ["admin", "users", identity?.store_id],
    queryFn: () =>
      api<AdminUserListResponse>("/api/v2/admin/users"),
  });
}

export function useAdminUser(uid: number | null) {
  return useQuery<AdminUserDetailResponse>({
    enabled: uid != null && Number.isFinite(uid),
    queryKey: ["admin", "users", "detail", uid],
    queryFn: () =>
      api<AdminUserDetailResponse>(`/api/v2/admin/users/${uid}`),
  });
}

export async function createAdminUser(
  body: AdminUserCreateBody,
): Promise<AdminUserRow> {
  return api<AdminUserRow>(
    "/api/v2/admin/users",
    { method: "POST", json: body },
  );
}

export async function updateAdminUser(
  uid: number, body: AdminUserUpdateBody,
): Promise<AdminUserRow> {
  return api<AdminUserRow>(
    `/api/v2/admin/users/${uid}`,
    { method: "PATCH", json: body },
  );
}

// ── Per-user custom access (R-1 overlay) ───────────────────

/** resource → action → allowed */
export type PermMatrix = Record<string, Record<string, boolean>>;

export interface UserPermissionMatrix {
  user_id:   number;
  role:      string;
  store_id:  number;
  resources: string[];
  actions:   string[];
  matrix:    PermMatrix;
  has_custom: boolean;
}

export function useAdminUserPermissions(uid: number | null) {
  return useQuery<UserPermissionMatrix>({
    enabled: uid != null && Number.isFinite(uid),
    queryKey: ["admin", "users", "permissions", uid],
    queryFn: () =>
      api<UserPermissionMatrix>(`/api/v2/admin/users/${uid}/permissions`),
  });
}

export async function setAdminUserPermissions(
  uid: number, matrix: PermMatrix,
): Promise<UserPermissionMatrix> {
  return api<UserPermissionMatrix>(
    `/api/v2/admin/users/${uid}/permissions`,
    { method: "PUT", json: { matrix } },
  );
}

export async function clearAdminUserPermissions(
  uid: number,
): Promise<UserPermissionMatrix> {
  return api<UserPermissionMatrix>(
    `/api/v2/admin/users/${uid}/permissions`,
    { method: "DELETE" },
  );
}
