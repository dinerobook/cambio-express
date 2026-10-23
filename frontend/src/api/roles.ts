import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { PillTone } from "../components/ui";
import type { components } from "./openapi";

type Schemas = components["schemas"];

/** UI-STANDARDS §3 role pills — one tone per built-in role on every
 *  screen. admin is the store's live operator (accent), employee is
 *  the plain default (neutral), owner is a secondary identity (info).
 *  The platform roles are not failures, so neither is red:
 *  superadmin is the login to handle with care (warning) and support
 *  is a secondary, tickets-only identity (info). Unknown → neutral. */
export const ROLE_TONES: Record<string, PillTone> = {
  admin:      "accent",
  employee:   "neutral",
  owner:      "info",
  superadmin: "warning",
  support:    "info",
};

export function roleTone(role: string): PillTone {
  return ROLE_TONES[role] ?? "neutral";
}

/** The one display name per built-in role, on every screen
 *  (UI-STANDARDS §7b). Unknown roles show as stored. */
export const ROLE_LABELS: Record<string, string> = {
  admin:      "Admin",
  employee:   "Employee",
  owner:      "Owner",
  superadmin: "Superadmin",
  support:    "Support",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

// Named access roles (R-3).

export type PermMatrix = Record<string, Record<string, boolean>>;

/** A saved role. `affected_members` comes only on the answer to an
 *  edit (who had their access rewritten). */
export type AccessRole = Schemas["AccessRoleRow"]
  & Partial<Pick<Schemas["AccessRoleUpdateResponse"], "affected_members">>;

export type RoleMember = Schemas["AccessRoleMember"];

export type RoleListResponse = Schemas["AccessRoleListResponse"];

export function useAccessRoles() {
  return useQuery<RoleListResponse>({
    queryKey: ["admin", "roles"],
    queryFn: () => api<RoleListResponse>("/api/v2/admin/roles"),
  });
}

/** Who an edit would affect — the SPA names them in the
 *  confirmation before a propagating save. */
export async function fetchRoleMembers(
  roleId: number,
): Promise<Schemas["AccessRoleMembersResponse"]> {
  return api(`/api/v2/admin/roles/${roleId}/members`);
}

export async function createAccessRole(body: {
  name: string; matrix: PermMatrix;
}): Promise<AccessRole> {
  return api<AccessRole>("/api/v2/admin/roles", {
    method: "POST", json: body,
  });
}

export async function updateAccessRole(
  id: number, body: { name?: string; matrix?: PermMatrix },
): Promise<Schemas["AccessRoleUpdateResponse"]> {
  return api<Schemas["AccessRoleUpdateResponse"]>(`/api/v2/admin/roles/${id}`, {
    method: "PUT", json: body,
  });
}

export async function deleteAccessRole(
  id: number,
): Promise<Schemas["AccessRoleDeleteResponse"]> {
  return api(`/api/v2/admin/roles/${id}`, { method: "DELETE" });
}

/** Put a user in a saved role, or take them out (`null`). */
export async function assignAccessRole(
  userId: number, roleId: number | null,
): Promise<Schemas["UserRoleAssignmentResponse"]> {
  return api(`/api/v2/admin/users/${userId}/role`, {
    method: "PUT", json: { role_id: roleId },
  });
}

// ── Built-in roles (Admin / Employee) ─────────────────────────
// The store's own defaults for its two base roles — what a person
// who is in no saved role and has no custom access can do. A store
// admin may edit the Employee row only (`editable_roles`).

export type BuiltinRolesResponse = Schemas["StorePermissionMatrix"];

export function useBuiltinRoles(enabled = true) {
  return useQuery<BuiltinRolesResponse>({
    enabled,
    queryKey: ["store-permissions"],
    queryFn: () =>
      api<BuiltinRolesResponse>("/api/v2/admin/store-permissions"),
  });
}

export async function saveBuiltinRole(
  role: string, matrix: PermMatrix,
): Promise<BuiltinRolesResponse> {
  return api<BuiltinRolesResponse>("/api/v2/admin/store-permissions", {
    method: "PUT", json: { matrix: { [role]: matrix } },
  });
}

export async function resetBuiltinRole(
  role: string,
): Promise<BuiltinRolesResponse> {
  return api<BuiltinRolesResponse>(
    "/api/v2/admin/store-permissions/reset",
    { method: "POST", json: { role } },
  );
}
