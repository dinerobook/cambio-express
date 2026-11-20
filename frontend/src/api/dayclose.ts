import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { fileToBase64 } from "../lib/files";
import type { components } from "./openapi";

// Typed straight off the FastAPI OpenAPI spec (CLAUDE.md standard).
export type Department = components["schemas"]["DepartmentRow"];
export type RegisterClose = components["schemas"]["RegisterCloseRow"];
export type DayCloseSummary = components["schemas"]["DayCloseSummaryResponse"];
export type RegisterCloseWrite =
  components["schemas"]["RegisterCloseWriteRequest"];

export type DepartmentType = Department["department_type"];
// The server fills every field but the name with its default, so a
// caller may send only what it sets (the generated type marks
// defaulted fields as present).
type DepartmentWriteSchema = components["schemas"]["DepartmentWriteRequest"];
export type DepartmentWrite =
  Pick<DepartmentWriteSchema, "name"> & Partial<Omit<DepartmentWriteSchema, "name">>;
export type DepartmentUpdate = components["schemas"]["DepartmentUpdateRequest"];

type DepartmentListResponse = components["schemas"]["DepartmentListResponse"];
type DepartmentResponse = components["schemas"]["DepartmentResponse"];

export function useDepartments(includeInactive = false) {
  const qs = includeInactive ? "?include_inactive=1" : "";
  return useQuery<DepartmentListResponse>({
    queryKey: ["dayclose", "departments", includeInactive],
    queryFn: () =>
      api<DepartmentListResponse>(`/api/v2/dayclose/departments${qs}`),
  });
}

export function useDayClose(day: string) {
  return useQuery<DayCloseSummary>({
    enabled: day.length === 10,
    queryKey: ["dayclose", "day", day],
    queryFn: () => api<DayCloseSummary>(`/api/v2/dayclose/day/${day}`),
  });
}

export async function createDepartment(
  body: DepartmentWrite,
): Promise<DepartmentResponse> {
  return api<DepartmentResponse>("/api/v2/dayclose/departments", {
    method: "POST", json: body,
  });
}

// PATCH-style: an omitted field is left unchanged. parent_id 0 and
// min_age 0 clear the value; pos_codes is the complete new list.
export async function updateDepartment(
  id: number,
  body: DepartmentUpdate,
): Promise<DepartmentResponse> {
  return api<DepartmentResponse>(`/api/v2/dayclose/departments/${id}`, {
    method: "PUT", json: body,
  });
}

export async function upsertRegisterClose(
  day: string, body: RegisterCloseWrite,
): Promise<DayCloseSummary> {
  return api<DayCloseSummary>(`/api/v2/dayclose/day/${day}/closes`, {
    method: "POST", json: body,
  });
}

export async function deleteRegisterClose(
  id: number,
): Promise<DayCloseSummary> {
  return api<DayCloseSummary>(`/api/v2/dayclose/closes/${id}`, {
    method: "DELETE",
  });
}


// ── Modisoft department import ─────────────────────────────
// Check the export (writes nothing), then import the rows the person
// kept with the type they chose. Rules: api/Modules/DayClose/Services/
// modisoft_departments.py.
export type DepartmentImportCheck = components["schemas"]["DepartmentImportCheckResponse"];
export type DepartmentImportCheckRow = components["schemas"]["DepartmentImportCheckRow"];
export type DepartmentImportRow = components["schemas"]["DepartmentImportRow"];
export type DepartmentImportResult = components["schemas"]["DepartmentImportResponse"];

export async function checkModisoftDepartments(file: File): Promise<DepartmentImportCheck> {
  return api<DepartmentImportCheck>("/api/v2/dayclose/departments/import/modisoft/check", {
    method: "POST", json: { content_base64: await fileToBase64(file) },
  });
}

export async function importDepartments(
  rows: DepartmentImportRow[],
): Promise<DepartmentImportResult> {
  return api<DepartmentImportResult>("/api/v2/dayclose/departments/import/modisoft", {
    method: "POST", json: { rows },
  });
}
