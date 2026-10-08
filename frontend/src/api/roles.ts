import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";

// Named access roles (R-3). Hand-written types: the roles routes
// return plain dicts rather than Pydantic response models, so
// there is nothing in openapi.d.ts to import.

export type PermMatrix = Record<string, Record<string, boolean>>;

export interface AccessRole {
  id: number;
  name: string;
  member_count: number;
  matrix: PermMatrix;
  updated_at: string | null;
  /** Present only on the response to an edit that propagated. */
  affected_members?: RoleMember[];
}

export interface RoleMember {
  id: number;
  name: string;
  role?: string;
}

export interface RoleListResponse {
  resources: string[];
  actions: string[];
  roles: AccessRole[];
}

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
): Promise<{ role_id: number; name: string; members: RoleMember[] }> {
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
): Promise<AccessRole> {
  return api<AccessRole>(`/api/v2/admin/roles/${id}`, {
    method: "PUT", json: body,
  });
}

export async function deleteAccessRole(
  id: number,
): Promise<{ deleted: string; detached: RoleMember[] }> {
  return api(`/api/v2/admin/roles/${id}`, { method: "DELETE" });
}

/** Put a user in a saved role, or take them out (`null`). */
export async function assignAccessRole(
  userId: number, roleId: number | null,
): Promise<{ store_role_id: number | null; store_role_name: string | null }> {
  return api(`/api/v2/admin/users/${userId}/role`, {
    method: "PUT", json: { role_id: roleId },
  });
}

// ── Built-in roles (Admin / Employee) ─────────────────────────
// The store's own defaults for its two base roles — what a person
// who is in no saved role and has no custom access can do. A store
// admin may edit the Employee row only (`editable_roles`).

export interface BuiltinRolesResponse {
  roles: string[];
  editable_roles: string[];
  resources: string[];
  actions: string[];
  matrix: Record<string, PermMatrix>;
  has_overrides: string[];
}

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
