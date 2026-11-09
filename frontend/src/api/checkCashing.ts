// Check cashing API hooks (standalone module behind the store's
// `check_desk` switch). Backed by /api/v2/check-cashing.
// Rules: api/Modules/CheckCashing/INVARIANTS.md.

import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney2 } from "../lib/formatters";
import type { PillTone } from "../components/ui";
import type { components } from "./openapi";
import { t, type MessageKey } from "../i18n";

export type CheckSettings = components["schemas"]["CheckSettingsResponse"];
export type CheckSettingsBody = components["schemas"]["CheckSettingsBody"];
export type CheckCustomerRow = components["schemas"]["CheckCustomerRow"];
export type CheckCustomerDetail = components["schemas"]["CheckCustomerDetail"];
export type CheckCustomerIdRow = components["schemas"]["CheckCustomerIdRow"];
export type CheckCustomerIdBody = components["schemas"]["CheckCustomerIdBody"];
export type CheckCustomerCreateBody = components["schemas"]["CheckCustomerCreateBody"];
export type CheckCustomerUpdateBody = components["schemas"]["CheckCustomerUpdateBody"];
export type CheckCompanyRow = components["schemas"]["CheckCompanyRow"];
export type CheckCompanyDetail = components["schemas"]["CheckCompanyDetail"];
export type CheckCompanyBody = components["schemas"]["CheckCompanyBody"];
type CustomerList = components["schemas"]["CheckCustomerListResponse"];
type CompanyList = components["schemas"]["CheckCompanyListResponse"];
type CustomerResponse = components["schemas"]["CheckCustomerResponse"];
type CompanyResponse = components["schemas"]["CheckCompanyResponse"];

const BASE = "/api/v2/check-cashing";

// ── Stored values → words ────────────────────────────────────

export const PARTY_STATUSES = ["normal", "trusted", "blocked"] as const;
export type PartyStatus = (typeof PARTY_STATUSES)[number];

/** Status → Pill tone (UI-STANDARDS §3): trusted is good, blocked a
 *  stop, normal nothing special. */
export const PARTY_STATUS_TONES: Record<string, PillTone> = {
  normal: "neutral",
  trusted: "success",
  blocked: "negative",
};

const PARTY_STATUS_KEYS: Record<string, MessageKey> = {
  normal: "checkCashing.statusNormal",
  trusted: "checkCashing.statusTrusted",
  blocked: "checkCashing.statusBlocked",
};

export function partyStatusLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return Object.hasOwn(PARTY_STATUS_KEYS, value) ? t(PARTY_STATUS_KEYS[value]) : value;
}

export const ID_TYPES = [
  "drivers_license", "state_id", "passport", "matricula", "military_id", "other",
] as const;
export type IdType = (typeof ID_TYPES)[number];

const ID_TYPE_KEYS: Record<string, MessageKey> = {
  drivers_license: "checkCashing.idDriversLicense",
  state_id: "checkCashing.idStateId",
  passport: "checkCashing.idPassport",
  matricula: "checkCashing.idMatricula",
  military_id: "checkCashing.idMilitary",
  other: "checkCashing.idOther",
};

export function idTypeLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return Object.hasOwn(ID_TYPE_KEYS, value) ? t(ID_TYPE_KEYS[value]) : value;
}

/** "1.5%" or "$3.00"; "—" when there is no own fee. */
export function feeLabel(
  kind: string | null | undefined, value: number | null | undefined,
): string {
  if (!kind || value == null) return "—";
  if (kind === "percent") return `${Number(value.toFixed(2))}%`;
  return fmtMoney2(value);
}

// ── Settings ─────────────────────────────────────────────────

export function useCheckSettings() {
  const identity = getCurrentIdentity();
  return useQuery<CheckSettings>({
    enabled: identity?.store_id != null,
    queryKey: ["check-cashing", "settings", identity?.store_id],
    queryFn: () => api<CheckSettings>(`${BASE}/settings`),
  });
}

export function saveCheckSettings(body: CheckSettingsBody): Promise<CheckSettings> {
  return api<CheckSettings>(`${BASE}/settings`, { method: "PUT", json: body });
}

// ── Lists ────────────────────────────────────────────────────

export interface PartyListQuery {
  q?: string; status?: string; sort?: string; dir?: "asc" | "desc";
  page?: number; perPage?: number;
}

function listQs({
  q = "", status = "", sort = "name", dir = "asc", page = 1, perPage = 50,
}: PartyListQuery): string {
  const qs = new URLSearchParams({
    sort, dir, page: String(page), per_page: String(perPage),
  });
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  return qs.toString();
}

// ── Customers ────────────────────────────────────────────────

/** One page of check customers — the list page and its CSV export
 *  make the same request. */
export function fetchCheckCustomersPage(query: PartyListQuery = {}): Promise<CustomerList> {
  return api<CustomerList>(`${BASE}/customers?${listQs(query)}`);
}

export function useCheckCustomers(query: PartyListQuery = {}) {
  const identity = getCurrentIdentity();
  return useQuery<CustomerList>({
    enabled: identity?.store_id != null,
    queryKey: ["check-cashing", "customers", identity?.store_id, listQs(query)],
    queryFn: () => fetchCheckCustomersPage(query),
    placeholderData: (prev) => prev,
  });
}

export function useCheckCustomer(id: number | undefined) {
  const identity = getCurrentIdentity();
  return useQuery<CustomerResponse>({
    enabled: Number.isFinite(id) && identity?.store_id != null,
    queryKey: ["check-cashing", "customer", identity?.store_id, id],
    queryFn: () => api<CustomerResponse>(`${BASE}/customers/${id}`),
  });
}

export function createCheckCustomer(body: CheckCustomerCreateBody): Promise<CustomerResponse> {
  return api<CustomerResponse>(`${BASE}/customers`, { method: "POST", json: body });
}

export function updateCheckCustomer(
  id: number, body: CheckCustomerUpdateBody,
): Promise<CustomerResponse> {
  return api<CustomerResponse>(`${BASE}/customers/${id}`, { method: "PUT", json: body });
}

export function addCheckCustomerId(
  id: number, body: CheckCustomerIdBody,
): Promise<CustomerResponse> {
  return api<CustomerResponse>(`${BASE}/customers/${id}/ids`, { method: "POST", json: body });
}

export function updateCheckCustomerId(
  id: number, idRowId: number, body: CheckCustomerIdBody,
): Promise<CustomerResponse> {
  return api<CustomerResponse>(
    `${BASE}/customers/${id}/ids/${idRowId}`, { method: "PUT", json: body },
  );
}

export function deleteCheckCustomerId(id: number, idRowId: number): Promise<CustomerResponse> {
  return api<CustomerResponse>(
    `${BASE}/customers/${id}/ids/${idRowId}`, { method: "DELETE" },
  );
}

// ── Companies ────────────────────────────────────────────────

export function fetchCheckCompaniesPage(query: PartyListQuery = {}): Promise<CompanyList> {
  return api<CompanyList>(`${BASE}/companies?${listQs(query)}`);
}

export function useCheckCompanies(query: PartyListQuery = {}) {
  const identity = getCurrentIdentity();
  return useQuery<CompanyList>({
    enabled: identity?.store_id != null,
    queryKey: ["check-cashing", "companies", identity?.store_id, listQs(query)],
    queryFn: () => fetchCheckCompaniesPage(query),
    placeholderData: (prev) => prev,
  });
}

export function useCheckCompany(id: number | undefined) {
  const identity = getCurrentIdentity();
  return useQuery<CompanyResponse>({
    enabled: Number.isFinite(id) && identity?.store_id != null,
    queryKey: ["check-cashing", "company", identity?.store_id, id],
    queryFn: () => api<CompanyResponse>(`${BASE}/companies/${id}`),
  });
}

export function createCheckCompany(body: CheckCompanyBody): Promise<CompanyResponse> {
  return api<CompanyResponse>(`${BASE}/companies`, { method: "POST", json: body });
}

export function updateCheckCompany(id: number, body: CheckCompanyBody): Promise<CompanyResponse> {
  return api<CompanyResponse>(`${BASE}/companies/${id}`, { method: "PUT", json: body });
}

/** A blank ID document for the editors. */
export const EMPTY_ID: CheckCustomerIdBody = {
  id_type: "drivers_license", id_number: "", issuer: "", expires_on: null,
};
