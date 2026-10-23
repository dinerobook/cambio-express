// Superadmin API hooks. Backed by /api/v2/superadmin/*.
//
// First slice: stores list. Controls dashboard, anomaly feed,
// audit log, announcements / discounts / feature-flag CRUD,
// and impersonation ship in subsequent PRs.

import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import type { PillTone } from "../components/ui";
import type { components } from "./openapi";

/** Resend email event → Pill tone for the superadmin email log.
 *  Delivered / opened / clicked are completed outcomes (success),
 *  not live state. */
export const EMAIL_EVENT_TONES: Record<string, PillTone> = {
  "email.sent":             "neutral",
  "email.delivered":        "success",
  "email.opened":           "success",
  "email.clicked":          "success",
  "email.delivery_delayed": "warning",
  "email.bounced":          "negative",
  "email.complained":       "negative",
};

export type SuperadminStoreDetailResponse = components["schemas"]["SuperadminStoreDetailResponse"];

// POST body — mirrors the legacy form. `plan` defaults to "trial"
// server-side if omitted, but we always send it to avoid relying
// on the default.
export interface SuperadminStoreCreateBody {
  name: string;
  slug: string;
  email?: string;
  phone?: string;
  address?: string;
  plan?: string;
  business_type?: string;
  admin_username?: string;
  admin_name?: string;
  admin_password: string;
  // U-5b: "owner" makes the initial user a role=owner with this
  // store as home (+ StoreOwnerLink) — concierge onboarding.
  initial_role?: string;
}

// PATCH body — every field optional. Only keys present are applied.
export interface SuperadminStoreUpdateBody {
  name?: string;
  slug?: string;
  email?: string;
  phone?: string;
  address?: string;
  plan?: string;
  business_type?: string;
  federal_tax_rate?: number;
}

export type SuperadminStoreRow = components["schemas"]["SuperadminStoreRow"];

export type SuperadminStoreListResponse = components["schemas"]["SuperadminStoreListResponse"];

export function useSuperadminStores() {
  const identity = getCurrentIdentity();
  return useQuery<SuperadminStoreListResponse>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "stores", identity?.user_id],
    queryFn: () =>
      api<SuperadminStoreListResponse>("/api/v2/superadmin/stores"),
  });
}

/** One page of the platform stores list: server search over name /
 *  slug / email, sort and paging. Pickers that need every store keep
 *  ``useSuperadminStores``. */
export function useSuperadminStoresPage(opts: {
  q: string; sort?: string; dir?: string; page: number; perPage: number;
}) {
  const identity = getCurrentIdentity();
  const { q, sort = "", dir = "desc", page, perPage } = opts;
  return useQuery<SuperadminStoreListResponse>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "stores", identity?.user_id, "page", q, sort, dir, page, perPage],
    queryFn: () => {
      const qs = new URLSearchParams({
        q, sort, dir, page: String(page), per_page: String(perPage),
      });
      return api<SuperadminStoreListResponse>(`/api/v2/superadmin/stores?${qs}`);
    },
    placeholderData: (prev) => prev,
  });
}


export type SuperadminAuditRow = components["schemas"]["SuperadminAuditRow"];

export type SuperadminAuditListResponse = components["schemas"]["SuperadminAuditListResponse"];

// Single-store detail (used by the edit-form prefill). Disabled
// when storeId is null/undefined so the create-form path skips
// the fetch entirely.
export function useSuperadminStore(storeId: number | null | undefined) {
  const identity = getCurrentIdentity();
  return useQuery<SuperadminStoreDetailResponse>({
    enabled:
      identity?.role === "superadmin" &&
      storeId !== null && storeId !== undefined &&
      Number.isFinite(storeId),
    queryKey: ["superadmin", "store", storeId, identity?.user_id],
    queryFn: () =>
      api<SuperadminStoreDetailResponse>(
        `/api/v2/superadmin/stores/${storeId}`,
      ),
  });
}

export async function createSuperadminStore(
  body: SuperadminStoreCreateBody,
): Promise<SuperadminStoreDetailResponse> {
  return api<SuperadminStoreDetailResponse>(
    "/api/v2/superadmin/stores",
    { method: "POST", json: body },
  );
}

export async function updateSuperadminStore(
  storeId: number, body: SuperadminStoreUpdateBody,
): Promise<SuperadminStoreDetailResponse> {
  return api<SuperadminStoreDetailResponse>(
    `/api/v2/superadmin/stores/${storeId}`,
    { method: "PATCH", json: body },
  );
}


export function useSuperadminAuditLog(
  page = 1, action = "", perPage = 50,
) {
  const identity = getCurrentIdentity();
  return useQuery<SuperadminAuditListResponse>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "audit-log", identity?.user_id, page, action, perPage],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set("page", String(page));
      p.set("per_page", String(perPage));
      if (action) p.set("action", action);
      return api<SuperadminAuditListResponse>(
        `/api/v2/superadmin/audit-log?${p.toString()}`,
      );
    },
    placeholderData: (prev) => prev,
  });
}


// ── Report center ───────────────────────────────────────────

export type SuperadminReportRow = components["schemas"]["SuperadminReportRow"];

export type SuperadminReportCategory = components["schemas"]["SuperadminReportCategory"];

export type SuperadminReportListResponse = components["schemas"]["SuperadminReportListResponse"];

export function useSuperadminReports() {
  const identity = getCurrentIdentity();
  return useQuery<SuperadminReportListResponse>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "reports", identity?.user_id],
    queryFn: () =>
      api<SuperadminReportListResponse>("/api/v2/superadmin/reports"),
  });
}


type Schemas = components["schemas"];

export type PlanDistEntry = Schemas["SuperadminPlanCount"];
export type VolumeByCompany = Schemas["SuperadminCompanyVolume"];
export type TopReferrer = Schemas["SuperadminTopReferrer"];
export type ActivityEntry = Schemas["SuperadminActivityRow"];
export type SuperadminDashboardData = Schemas["SuperadminDashboardResponse"];

export function useSuperadminDashboard() {
  const identity = getCurrentIdentity();
  return useQuery<SuperadminDashboardData>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "dashboard"],
    queryFn: () =>
      api<SuperadminDashboardData>("/api/v2/superadmin/dashboard"),
  });
}


export type SuperadminUserRow = Schemas["SuperadminUserRow"];
type SuperadminUserListResponse = Schemas["SuperadminUserListResponse"];

export function useSuperadminUsers(opts: {
  q?: string; role?: string; store_id?: number; page?: number; perPage?: number;
}) {
  const identity = getCurrentIdentity();
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.role) params.set("role", opts.role);
  if (opts.store_id) params.set("store_id", String(opts.store_id));
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  const qs = params.toString() ? `?${params}` : "";
  return useQuery<SuperadminUserListResponse>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "users", opts.q, opts.role, opts.store_id, opts.page, opts.perPage],
    queryFn: () =>
      api<SuperadminUserListResponse>(`/api/v2/superadmin/users${qs}`),
    placeholderData: (prev) => prev,
  });
}

export async function createPlatformUser(body: {
  username: string;
  full_name: string;
  email: string;
  password: string;
}) {
  return api<Schemas["SuperadminPlatformUserResponse"]>("/api/v2/superadmin/platform-users", { method: "POST", json: body });
}

export async function changeUserRole(userId: number, role: string) {
  return api<Schemas["SuperadminChangeRoleResponse"]>(
    `/api/v2/superadmin/users/${userId}/change-role`,
    { method: "POST", json: { role } },
  );
}

export async function toggleUserActive(userId: number) {
  return api<Schemas["SuperadminToggleActiveResponse"]>(
    `/api/v2/superadmin/users/${userId}/toggle-active`,
    { method: "POST" },
  );
}

export async function resetUser2FA(userId: number) {
  return api<Schemas["OkResponse"]>(
    `/api/v2/superadmin/users/${userId}/reset-2fa`,
    { method: "POST" },
  );
}

export async function forcePasswordReset(userId: number) {
  return api<Schemas["SuperadminTempPasswordResponse"]>(
    `/api/v2/superadmin/users/${userId}/force-password-reset`,
    { method: "POST" },
  );
}

export async function revokeUserSessions(userId: number) {
  return api<Schemas["SuperadminRevokeSessionsResponse"]>(
    `/api/v2/superadmin/users/${userId}/revoke-sessions`,
    { method: "POST" },
  );
}

/** "full" acts as the person (writes allowed, recorded "via
 *  superadmin"); "read_only" only looks — the server refuses every
 *  write on that session with 403 `read_only_impersonation`. */
export type ImpersonationMode = "full" | "read_only";

export async function impersonateUser(
  userId: number, mode: ImpersonationMode = "full",
) {
  return api<Schemas["SuperadminImpersonateResponse"]>(
    `/api/v2/superadmin/impersonate/${userId}`,
    { method: "POST", json: { mode } },
  );
}

/** Ends an impersonation on the server (audit row + the customer's
 *  access cookie dropped). Call through `lib/impersonation.ts`,
 *  which also restores the superadmin's own session. */
export async function stopImpersonationRequest() {
  return api<Schemas["OkResponse"]>(
    "/api/v2/superadmin/impersonate/stop",
    { method: "POST" },
  );
}

export interface ExtendTrialResponse {
  ok: boolean;
  plan: string;
  trial_ends_at: string;
  grace_ends_at: string;
  trial_status: string;
}

/** `days` counts from the later of the trial's current end and
 *  today; `endsOn` (YYYY-MM-DD) sets the end date instead. */
export async function extendTrial(
  storeId: number,
  opts: { days?: number; endsOn?: string } = {},
) {
  const json: { days?: number; ends_on?: string } = {};
  if (opts.endsOn) json.ends_on = opts.endsOn;
  else json.days = opts.days ?? 14;
  return api<ExtendTrialResponse>(
    `/api/v2/superadmin/stores/${storeId}/extend-trial`,
    { method: "POST", json },
  );
}

export interface CompPlanResponse {
  ok: boolean;
  plan: string;
  billing_cycle: string;
  comped: boolean;
  comped_at: string;
  comp_reason: string;
  /** The store's Stripe subscription was paused (collection
   *  voided) as part of this call. */
  stripe_paused: boolean;
  /** The store's Stripe subscription was resumed as part of this
   *  call. */
  stripe_resumed: boolean;
}

/** Put a store on a free Basic/Pro plan. A paying store keeps its
 *  Stripe subscription but collection is paused, so nothing is
 *  invoiced until `endComp`. 503 when Stripe is not configured,
 *  502 when the pause fails (the plan is then left untouched). */
export async function compStore(
  storeId: number, body: { plan: "basic" | "pro"; reason: string },
) {
  return api<CompPlanResponse>(
    `/api/v2/superadmin/stores/${storeId}/comp-plan`,
    { method: "POST", json: body },
  );
}

/** End a comp: resumes Stripe collection and puts the plan back to
 *  what the subscription pays for; with no subscription the store
 *  gets a fresh trial window. 409 when the store is not comped. */
export async function endComp(storeId: number) {
  return api<CompPlanResponse>(
    `/api/v2/superadmin/stores/${storeId}/end-comp`,
    { method: "POST" },
  );
}

export type StoreAuditLogResponse = Schemas["SuperadminStoreAuditLogResponse"];

/** The store's own activity feed (what its admin sees on
 *  /app/admin/audit-log), read from the superadmin store page. */
export function useStoreAuditLog(
  storeId: number | undefined,
  opts: { page?: number; target?: string; action?: string; perPage?: number } = {},
) {
  const page = opts.page ?? 1;
  const perPage = opts.perPage ?? 50;
  const target = opts.target ?? "";
  const action = opts.action ?? "";
  return useQuery<StoreAuditLogResponse>({
    enabled: storeId != null,
    queryKey: ["superadmin", "store-audit-log", storeId, page, target, action, perPage],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set("page", String(page));
      p.set("per_page", String(perPage));
      if (target) p.set("target", target);
      if (action) p.set("action", action);
      return api<StoreAuditLogResponse>(
        `/api/v2/superadmin/stores/${storeId}/audit-log?${p.toString()}`,
      );
    },
    placeholderData: (prev) => prev,
  });
}

export interface StoreFeatureRow {
  key: string;
  label: string;
  description: string;
  kind: "module" | "addon" | "flag";
  /** What the store gets with no override: the business-type
   *  bundle for modules, the global default otherwise. */
  default: boolean;
  /** The per-store override when one is set. */
  override: boolean | null;
  /** What the store's users see right now. */
  effective: boolean;
}

export interface StoreFeatureListResponse {
  store_id: number;
  business_type: string;
  rows: StoreFeatureRow[];
}

export function useStoreFeatures(storeId: number | undefined) {
  return useQuery<StoreFeatureListResponse>({
    enabled: storeId != null,
    queryKey: ["superadmin", "store-features", storeId],
    queryFn: () =>
      api<StoreFeatureListResponse>(
        `/api/v2/superadmin/stores/${storeId}/features`,
      ),
  });
}

export type RetentionDryRunStoreRow = Schemas["SuperadminRetentionStore"];
export type RetentionDryRunResponse = Schemas["SuperadminRetentionDryRunResponse"];

export async function retentionDryRun() {
  return api<RetentionDryRunResponse>(
    `/api/v2/superadmin/retention-dry-run`,
    { method: "GET" },
  );
}

export async function clearStoreRetention(storeId: number) {
  return api<Schemas["SuperadminClearRetentionResponse"]>(
    `/api/v2/superadmin/stores/${storeId}/clear-retention`,
    { method: "POST" },
  );
}

export async function toggleStoreActive(storeId: number) {
  return api<Schemas["SuperadminToggleActiveResponse"]>(
    `/api/v2/superadmin/stores/${storeId}/toggle-active`,
    { method: "POST" },
  );
}

export interface StoreCreditResult {
  ok: boolean;
  amount_cents: number;
  stripe_txn_id: string;
}

// Issue a goodwill credit to a store's Stripe customer balance.
// `amountCents` is the POSITIVE credit size in cents (the backend
// negates it for Stripe). Surfaces 409 (no Stripe customer), 422
// (bad amount), 502/503 (Stripe error / not configured) as ApiError.
export async function creditStore(
  storeId: number, amountCents: number, reason: string,
) {
  return api<StoreCreditResult>(
    `/api/v2/superadmin/stores/${storeId}/credit`,
    { method: "POST", json: { amount_cents: amountCents, reason } },
  );
}

export interface StoreFreezeResult {
  ok: boolean;
  frozen: boolean;
  frozen_at: string;
  frozen_reason: string;
}

// Suspend a store (PR C). Its users get gated to a "suspended, contact
// support" screen. Re-subscribing does NOT lift it — only unfreezeStore.
export async function freezeStore(storeId: number, reason: string) {
  return api<StoreFreezeResult>(
    `/api/v2/superadmin/stores/${storeId}/freeze`,
    { method: "POST", json: { reason } },
  );
}

// Lift a store's suspension so its users can use the app again.
export async function unfreezeStore(storeId: number) {
  return api<StoreFreezeResult>(
    `/api/v2/superadmin/stores/${storeId}/unfreeze`,
    { method: "POST" },
  );
}

export async function emailStore(storeId: number, subject: string, message: string) {
  return api<Schemas["SuperadminStoreEmailResponse"]>(
    `/api/v2/superadmin/stores/${storeId}/email`,
    { method: "POST", json: { subject, message } },
  );
}

export async function bulkStoreAction(
  store_ids: number[],
  action: "extend_trial" | "enable" | "disable",
  days?: number,
) {
  return api<Schemas["SuperadminBulkActionResponse"]>(
    `/api/v2/superadmin/bulk-action`,
    { method: "POST", json: { store_ids, action, days } },
  );
}


// ── Owner links (U-5b concierge onboarding) ────────────────

export type SuperadminOwnerLinkRow = components["schemas"]["SuperadminOwnerLinkRow"];

export type SuperadminOwnerLinkListResponse = components["schemas"]["SuperadminOwnerLinkListResponse"];

export function useStoreOwnerLinks(storeId: number | undefined) {
  return useQuery<SuperadminOwnerLinkListResponse>({
    enabled: storeId != null,
    queryKey: ["superadmin", "store", storeId, "owner-links"],
    queryFn: () =>
      api<SuperadminOwnerLinkListResponse>(
        `/api/v2/superadmin/stores/${storeId}/owner-links`,
      ),
  });
}

export async function linkOwnerToStore(
  storeId: number, ownerUsername: string,
): Promise<SuperadminOwnerLinkListResponse> {
  return api<SuperadminOwnerLinkListResponse>(
    `/api/v2/superadmin/stores/${storeId}/owner-links`,
    { method: "POST", json: { owner_username: ownerUsername } },
  );
}

export async function unlinkOwnerFromStore(
  storeId: number, ownerId: number,
): Promise<SuperadminOwnerLinkListResponse> {
  return api<SuperadminOwnerLinkListResponse>(
    `/api/v2/superadmin/stores/${storeId}/owner-links/${ownerId}`,
    { method: "DELETE" },
  );
}
