// Check cashing API hooks (standalone module behind the store's
// `check_desk` switch). Backed by /api/v2/check-cashing.
// Rules: api/Modules/CheckCashing/INVARIANTS.md.

import { useQuery } from "@tanstack/react-query";

import { api, fetchBlob } from "../lib/api";
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

export function useCheckCustomers(query: PartyListQuery = {}, enabled = true) {
  const identity = getCurrentIdentity();
  return useQuery<CustomerList>({
    enabled: enabled && identity?.store_id != null,
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

export function useCheckCompanies(query: PartyListQuery = {}, enabled = true) {
  const identity = getCurrentIdentity();
  return useQuery<CompanyList>({
    enabled: enabled && identity?.store_id != null,
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

// ── Cash a check ─────────────────────────────────────────────

export type CheckReviewBody = components["schemas"]["CheckReviewBody"];
export type CheckReview = components["schemas"]["CheckReviewResponse"];
export type CheckReviewItem = components["schemas"]["CheckReviewItemOut"];
export type CashCheckBody = components["schemas"]["CashCheckBody"];
export type CashedCheckRow = components["schemas"]["CashedCheckRow"];
export type CheckStats = components["schemas"]["CheckStatsOut"];
export type CheckActivity = components["schemas"]["CheckActivityResponse"];
export type CompanyCustomerRow = components["schemas"]["CompanyCustomerRow"];
type CashedCheckResponse = components["schemas"]["CashedCheckResponse"];
type CompanyCustomers = components["schemas"]["CompanyCustomersResponse"];
type CompanyLookup = components["schemas"]["CompanyLookupResponse"];

export type ReviewLevel = CheckReviewItem["level"];

/** Worst first: what the cashier must deal with comes on top. */
export const REVIEW_LEVEL_ORDER: ReviewLevel[] = ["block", "approve", "warn", "info"];

export const REVIEW_LEVEL_TONES: Record<ReviewLevel, PillTone> = {
  block: "negative",
  approve: "warning",
  warn: "warning",
  info: "neutral",
};

export function sortReviewItems(items: CheckReviewItem[]): CheckReviewItem[] {
  return [...items].sort(
    (a, b) => REVIEW_LEVEL_ORDER.indexOf(a.level) - REVIEW_LEVEL_ORDER.indexOf(b.level),
  );
}

export const CHECK_STATUS_TONES: Record<string, PillTone> = {
  cashed: "success",
  declined: "negative",
  voided: "neutral",
};

const CHECK_STATUS_KEYS: Record<string, MessageKey> = {
  cashed: "checkCashing.checkCashed",
  declined: "checkCashing.checkDeclined",
  voided: "checkCashing.checkVoided",
};

export function checkStatusLabel(value: string): string {
  return Object.hasOwn(CHECK_STATUS_KEYS, value) ? t(CHECK_STATUS_KEYS[value]) : value;
}

export function fetchCheckReview(body: CheckReviewBody): Promise<CheckReview> {
  return api<CheckReview>(`${BASE}/checks/review`, { method: "POST", json: body });
}

/** The fee and review for what the cashier has typed so far. A POST
 *  that changes nothing, cached by its body like any read. */
export function useCheckReview(body: CheckReviewBody, enabled: boolean) {
  const identity = getCurrentIdentity();
  return useQuery<CheckReview>({
    enabled: enabled && identity?.store_id != null,
    queryKey: ["check-cashing", "review", identity?.store_id, body],
    queryFn: () => fetchCheckReview(body),
    placeholderData: (prev) => prev,
  });
}

export function cashCheck(body: CashCheckBody): Promise<CashedCheckResponse> {
  return api<CashedCheckResponse>(`${BASE}/checks`, { method: "POST", json: body });
}

export function voidCheck(id: number, reason: string): Promise<CashedCheckResponse> {
  return api<CashedCheckResponse>(
    `${BASE}/checks/${id}/void`, { method: "POST", json: { reason } },
  );
}

/** Totals and the latest checks of a customer or a company. */
export function useCheckActivity(kind: "customers" | "companies", id: number | undefined) {
  const identity = getCurrentIdentity();
  return useQuery<CheckActivity>({
    enabled: id != null && Number.isFinite(id) && identity?.store_id != null,
    queryKey: ["check-cashing", "activity", identity?.store_id, kind, id],
    queryFn: () => api<CheckActivity>(`${BASE}/${kind}/${id}/activity`),
  });
}

export function useCompanyCustomers(id: number | undefined) {
  const identity = getCurrentIdentity();
  return useQuery<CompanyCustomers>({
    enabled: id != null && identity?.store_id != null,
    queryKey: ["check-cashing", "company-customers", identity?.store_id, id],
    queryFn: () => api<CompanyCustomers>(`${BASE}/companies/${id}/customers`),
  });
}

/** The company a check's routing + account belong to, if on file. */
export function useCompanyLookup(routing: string, account: string) {
  const identity = getCurrentIdentity();
  const ready = /^\d{9}$/.test(routing) && /^\d{1,20}$/.test(account);
  return useQuery<CompanyLookup>({
    enabled: ready && identity?.store_id != null,
    queryKey: ["check-cashing", "company-lookup", identity?.store_id, routing, account],
    queryFn: () => api<CompanyLookup>(
      `${BASE}/company-lookup?${new URLSearchParams({ routing, account })}`,
    ),
  });
}

// ── Checks list and the period report ────────────────────────

export type CheckReport = components["schemas"]["CheckReportResponse"];
export type CheckTotals = components["schemas"]["CheckTotalsOut"];
type CashedCheckList = components["schemas"]["CashedCheckListResponse"];

export interface CheckListQuery {
  q?: string; status?: string; from?: string; to?: string;
  page?: number; perPage?: number;
}

function checkListQs({
  q = "", status = "", from = "", to = "", page = 1, perPage = 50,
}: CheckListQuery): string {
  const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  return qs.toString();
}

/** One page of checks — the Checks page and its CSV export make the
 *  same request. */
export function fetchChecksPage(query: CheckListQuery = {}): Promise<CashedCheckList> {
  return api<CashedCheckList>(`${BASE}/checks?${checkListQs(query)}`);
}

export function useChecks(query: CheckListQuery = {}) {
  const identity = getCurrentIdentity();
  return useQuery<CashedCheckList>({
    enabled: identity?.store_id != null,
    queryKey: ["check-cashing", "checks", identity?.store_id, checkListQs(query)],
    queryFn: () => fetchChecksPage(query),
    placeholderData: (prev) => prev,
  });
}

/** Totals for a period: the Checks page's summary and the back office
 *  report (any device; an owner may have no store). */
export function useCheckReport(query: { from?: string; to?: string; storeId?: string }) {
  const identity = getCurrentIdentity();
  const qs = new URLSearchParams();
  if (query.from) qs.set("from", query.from);
  if (query.to) qs.set("to", query.to);
  if (query.storeId) qs.set("store_id", query.storeId);
  return useQuery<CheckReport>({
    queryKey: ["check-cashing", "report", identity?.store_id, qs.toString()],
    queryFn: () => api<CheckReport>(`${BASE}/report?${qs}`),
    placeholderData: (prev) => prev,
  });
}

// ── Bad checks ───────────────────────────────────────────────

export type BadCheckRow = components["schemas"]["BadCheckRow"];
export type BadCheckDetail = components["schemas"]["BadCheckDetailResponse"];
export type BadCheckPaymentRow = components["schemas"]["BadCheckPaymentRow"];
export type ReportBadCheckBody = components["schemas"]["ReportBadCheckBody"];
export type BadCheckReason = ReportBadCheckBody["reason"];
type BadCheckList = components["schemas"]["BadCheckListResponse"];

export const BAD_CHECK_REASONS: BadCheckReason[] = [
  "nsf", "closed_account", "stop_payment", "fraud", "other",
];

const BAD_CHECK_REASON_KEYS: Record<string, MessageKey> = {
  nsf: "checkCashing.badNsf",
  closed_account: "checkCashing.badClosedAccount",
  stop_payment: "checkCashing.badStopPayment",
  fraud: "checkCashing.badFraud",
  other: "checkCashing.badOther",
};

export function badCheckReasonLabel(value: string): string {
  return Object.hasOwn(BAD_CHECK_REASON_KEYS, value) ? t(BAD_CHECK_REASON_KEYS[value]) : value;
}

/** Open is money still owed (pending), paid back is good, written
 *  off a loss (UI-STANDARDS §3). */
export const BAD_CHECK_STATUS_TONES: Record<string, PillTone> = {
  open: "warning",
  paid: "success",
  written_off: "negative",
};

const BAD_CHECK_STATUS_KEYS: Record<string, MessageKey> = {
  open: "checkCashing.badStatusOpen",
  paid: "checkCashing.badStatusPaid",
  written_off: "checkCashing.badStatusWrittenOff",
};

export function badCheckStatusLabel(value: string): string {
  return Object.hasOwn(BAD_CHECK_STATUS_KEYS, value) ? t(BAD_CHECK_STATUS_KEYS[value]) : value;
}

export interface BadCheckListQuery {
  q?: string; status?: string; page?: number; perPage?: number;
}

function badListQs({ q = "", status = "", page = 1, perPage = 50 }: BadCheckListQuery): string {
  const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  return qs.toString();
}

/** One page of bad checks — the list page and its CSV export make
 *  the same request. */
export function fetchBadChecksPage(query: BadCheckListQuery = {}): Promise<BadCheckList> {
  return api<BadCheckList>(`${BASE}/bad-checks?${badListQs(query)}`);
}

export function useBadChecks(query: BadCheckListQuery = {}) {
  const identity = getCurrentIdentity();
  return useQuery<BadCheckList>({
    enabled: identity?.store_id != null,
    queryKey: ["check-cashing", "bad-checks", identity?.store_id, badListQs(query)],
    queryFn: () => fetchBadChecksPage(query),
    placeholderData: (prev) => prev,
  });
}

export function useBadCheck(id: number | null) {
  const identity = getCurrentIdentity();
  return useQuery<BadCheckDetail>({
    enabled: id != null && identity?.store_id != null,
    queryKey: ["check-cashing", "bad-check", identity?.store_id, id],
    queryFn: () => api<BadCheckDetail>(`${BASE}/bad-checks/${id}`),
  });
}

export function reportBadCheck(checkId: number, body: ReportBadCheckBody): Promise<BadCheckDetail> {
  return api<BadCheckDetail>(
    `${BASE}/checks/${checkId}/bad-check`, { method: "POST", json: body },
  );
}

export function addBadCheckPayment(
  id: number, body: { amount: number; note: string },
): Promise<BadCheckDetail> {
  return api<BadCheckDetail>(
    `${BASE}/bad-checks/${id}/payments`, { method: "POST", json: body },
  );
}

export function writeOffBadCheck(id: number, note: string): Promise<BadCheckDetail> {
  return api<BadCheckDetail>(
    `${BASE}/bad-checks/${id}/write-off`, { method: "POST", json: { note } },
  );
}

// ── The activated computer ───────────────────────────────────

export type CheckDevice = components["schemas"]["CheckDeviceResponse"];

/** Is this the store's check cashing computer? Every check cashing
 *  page asks first (DeskPage); the server refuses the rest anyway. */
export function useCheckDevice() {
  const identity = getCurrentIdentity();
  return useQuery<CheckDevice>({
    enabled: identity?.store_id != null,
    queryKey: ["check-cashing", "device", identity?.store_id],
    queryFn: () => api<CheckDevice>(`${BASE}/device`),
  });
}

export function activateCheckDevice(name: string): Promise<CheckDevice> {
  return api<CheckDevice>(`${BASE}/device/activate`, { method: "POST", json: { name } });
}

export function switchOffCheckDevice(): Promise<CheckDevice> {
  return api<CheckDevice>(`${BASE}/device/switch-off`, { method: "POST" });
}

// ── Pictures ─────────────────────────────────────────────────

export type CheckPictureBody = components["schemas"]["CheckPictureBody"];
export type CheckPicture = components["schemas"]["CheckPictureResponse"];
export type PictureKind = CheckPictureBody["kind"];

/** Save a picture (base64). The server cleans it and answers its id. */
export function uploadCheckPicture(body: CheckPictureBody): Promise<CheckPicture> {
  return api<CheckPicture>(`${BASE}/pictures`, { method: "POST", json: body });
}

/** A saved picture's bytes. A picture never changes (a new one gets
 *  a new id), so it is fetched once per page visit; it sits outside
 *  the "check-cashing" key so saving a check does not fetch it again. */
export function useCheckPictureBlob(id: number | null | undefined) {
  return useQuery<Blob>({
    enabled: id != null,
    queryKey: ["check-picture", id],
    queryFn: async () => (await fetchBlob(`${BASE}/pictures/${id}`)).blob,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}
