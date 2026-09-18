// Bank-sync API hooks. Backed by /api/v2/bank/{transactions,accounts,rules}.
//
// Read-only for SPA-29 — connect/disconnect/sync flows still
// live on the legacy Flask /bank routes (Stripe Financial
// Connections session needs Stripe.js to drive the modal).

import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";

export interface BankAccountRow {
  id: number;
  institution_name: string;
  display_name: string;
  nickname: string;
  last4: string;
  label: string;
  category: string;
  subcategory: string;
  currency: string;
  last_balance_cents: number;
  last_balance: number;
  last_balance_as_of: string;
  enabled: boolean;
  connected_at: string;
  disconnected_at: string;
}

export interface BankRuleRow {
  id: number;
  enabled: boolean;
  priority: number;
  desc_match_type: string;
  desc_match_value: string;
  sign_filter: string;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  account_filter_id: number | null;
  account_filter_label: string;
  target_kind: string;
  auto_post: boolean;
  /** Days to shift the booked day from the bank's posting date.
   *  0 = the bank's date; negative books earlier. */
  post_date_offset_days: number;
  description: string;
  match_count: number;
  last_matched_at: string;
}

export interface BankTransactionRow {
  id: number;
  posted_at: string;
  description: string;
  amount_cents: number;
  amount: number;
  currency: string;
  status: string;
  category_slug: string;
  account_id: number;
  account_label: string;
  /** Set when the category booked a line on the daily book. */
  daily_line_item_id: number | null;
  /** ISO date of the daily book the line landed on, "" if none. */
  booked_on: string;
  /** ISO date the operator (or a rule) chose for this row, "" when
   *  it books on the bank's own date. Survives a re-tag. */
  report_date_override: string;
  /** ISO date of `posted_at` — the day it books on with no
   *  override. */
  bank_date: string;
}

export interface BankTransactionListResponse {
  rows: BankTransactionRow[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
  page_total_cents: number;
  uncategorized_count: number;
}

export interface BankTransactionFilters {
  posted_from?: string;
  posted_to?: string;
  account_id?: string;
  category_slug?: string;
  sign?: "" | "credit" | "debit";
  q?: string;
  uncategorized_only?: boolean;
  page?: number;
  per_page?: number;
}

export function useBankAccounts() {
  const identity = getCurrentIdentity();
  return useQuery<{ rows: BankAccountRow[]; total: number }>({
    enabled: identity?.store_id != null,
    queryKey: ["bank", "accounts", identity?.store_id],
    queryFn: () =>
      api<{ rows: BankAccountRow[]; total: number }>("/api/v2/bank/accounts"),
  });
}

export function useBankRules(enabledOnly = false) {
  const identity = getCurrentIdentity();
  return useQuery<{ rows: BankRuleRow[]; total: number }>({
    enabled: identity?.store_id != null,
    queryKey: ["bank", "rules", identity?.store_id, enabledOnly],
    queryFn: () => {
      const qs = enabledOnly ? "?enabled_only=true" : "";
      return api<{ rows: BankRuleRow[]; total: number }>(
        `/api/v2/bank/rules${qs}`,
      );
    },
  });
}

export function useBankTransactions(filters: BankTransactionFilters) {
  const identity = getCurrentIdentity();
  return useQuery<BankTransactionListResponse>({
    enabled: identity?.store_id != null,
    queryKey: ["bank", "transactions", identity?.store_id, filters],
    queryFn: () => {
      const p = new URLSearchParams();
      if (filters.posted_from)        p.set("posted_from",   filters.posted_from);
      if (filters.posted_to)          p.set("posted_to",     filters.posted_to);
      if (filters.account_id)         p.set("account_id",    filters.account_id);
      if (filters.category_slug)      p.set("category_slug", filters.category_slug);
      if (filters.sign)               p.set("sign",          filters.sign);
      if (filters.q)                  p.set("q",             filters.q);
      if (filters.uncategorized_only) p.set("uncategorized_only", "true");
      if (filters.page)               p.set("page",     String(filters.page));
      if (filters.per_page)           p.set("per_page", String(filters.per_page));
      const qs = p.toString();
      return api<BankTransactionListResponse>(
        `/api/v2/bank/transactions${qs ? `?${qs}` : ""}`,
      );
    },
    placeholderData: (prev) => prev,
  });
}


// ── Categories ─────────────────────────────────────────────
//
// The server owns the category list (GET /bank/categories): the
// daily-book kinds that book a line, the monthly P&L lines, and the
// per-store bank-charge tags. The SPA used to hard-code a list here
// that had drifted from what the server accepted — never again.

export interface BankCategoryOption { slug: string; label: string }
export interface BankCategoryGroup {
  label: string;
  /** True for the group whose slugs book a daily-book line. */
  posts_to_daily: boolean;
  options: BankCategoryOption[];
}

export function useBankCategories() {
  const identity = getCurrentIdentity();
  return useQuery<{ groups: BankCategoryGroup[] }>({
    enabled: identity?.store_id != null,
    queryKey: ["bank", "categories", identity?.store_id],
    queryFn: () => api<{ groups: BankCategoryGroup[] }>("/api/v2/bank/categories"),
    staleTime: 5 * 60_000,
  });
}

/** Flat slug → label map over every group, for rendering a row's
 *  current category without walking the groups each time. */
export function categoryLabels(groups: BankCategoryGroup[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of groups ?? []) for (const o of g.options) m.set(o.slug, o.label);
  return m;
}

/** Slugs that book a line on the daily book. */
export function dailyBookSlugs(groups: BankCategoryGroup[] | undefined): Set<string> {
  const s = new Set<string>();
  for (const g of groups ?? []) if (g.posts_to_daily) for (const o of g.options) s.add(o.slug);
  return s;
}

export interface CategorizeBody {
  target_kind: string;
  post_to_daily?: boolean;
  /** Which day the line books on. Tri-state, matching the server:
   *  omit to keep the day the row already carries, an ISO date to
   *  book on that day and remember it, `null` to clear the choice
   *  and go back to the bank's posting date. */
  report_date?: string | null;
}

/** The 409 the categorize endpoint returns for a locked day. */
export interface DailyBookLockedDetail {
  code: "daily_book_locked";
  report_date: string;
  message: string;
}

export function lockedDayFromError(err: unknown): DailyBookLockedDetail | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as { detail?: unknown } | null;
  const d = body?.detail as Partial<DailyBookLockedDetail> | undefined;
  if (d && d.code === "daily_book_locked" && typeof d.report_date === "string") {
    return d as DailyBookLockedDetail;
  }
  return null;
}

export async function categorizeTransaction(
  txnId: number, body: CategorizeBody,
): Promise<{ transaction: BankTransactionRow }> {
  return api<{ transaction: BankTransactionRow }>(
    `/api/v2/bank/transactions/${txnId}/categorize`,
    { method: "POST", json: body },
  );
}

export async function uncategorizeTransaction(
  txnId: number,
): Promise<{ transaction: BankTransactionRow }> {
  return api<{ transaction: BankTransactionRow }>(
    `/api/v2/bank/transactions/${txnId}/uncategorize`,
    { method: "POST", json: {} },
  );
}


// ── Rule CRUD ──────────────────────────────────────────────

/** Description match operators — must agree with `DESC_MATCH_TYPES`
 *  in `api/Modules/BankSync/Services/matcher.py`. */
export const MATCH_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "contains",    label: "contains" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with",   label: "ends with" },
  { value: "equals",      label: "equals" },
  { value: "regex",       label: "matches regex" },
];

export interface BankRuleWriteBody {
  enabled: boolean;
  priority: number;
  desc_match_type: string;
  desc_match_value: string;
  sign_filter: string;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  account_filter_id: number | null;
  target_kind: string;
  auto_post: boolean;
  post_date_offset_days: number;
  description: string;
  /** Create only: run the rule over existing uncategorized rows. */
  apply_to_existing?: boolean;
}

export interface BankRuleApplyReport {
  tagged: number;
  booked: number;
  locked_skipped: number;
}

export interface BankRuleResponse {
  rule: BankRuleRow;
  applied: BankRuleApplyReport | null;
}

export async function createRule(
  body: BankRuleWriteBody,
): Promise<BankRuleResponse> {
  return api<BankRuleResponse>("/api/v2/bank/rules", {
    method: "POST",
    json: body,
  });
}

export async function applyRule(ruleId: number): Promise<BankRuleResponse> {
  return api<BankRuleResponse>(`/api/v2/bank/rules/${ruleId}/apply`, {
    method: "POST",
    json: {},
  });
}

export async function reorderRules(
  ids: number[],
): Promise<{ rows: BankRuleRow[]; total: number }> {
  return api<{ rows: BankRuleRow[]; total: number }>("/api/v2/bank/rules/reorder", {
    method: "POST",
    json: { ids },
  });
}

export async function updateRule(
  ruleId: number, body: BankRuleWriteBody,
): Promise<BankRuleResponse> {
  return api<BankRuleResponse>(`/api/v2/bank/rules/${ruleId}`, {
    method: "PUT",
    json: body,
  });
}

export async function toggleRule(
  ruleId: number, enabled: boolean,
): Promise<{ rule: BankRuleRow }> {
  return api<{ rule: BankRuleRow }>(
    `/api/v2/bank/rules/${ruleId}/toggle`,
    { method: "POST", json: { enabled } },
  );
}

export async function deleteRule(ruleId: number): Promise<void> {
  await api<void>(`/api/v2/bank/rules/${ruleId}`, { method: "DELETE" });
}


// ── Stripe FC connect lifecycle ────────────────────────────
//
// 5 endpoints under /api/v2/bank/* drive the Stripe Financial
// Connections flow.  All admin-role gated; all audited.
//
//   POST /api/v2/bank/connect            — mint a new FC session
//   POST /api/v2/bank/connect/complete   — persist the linked
//                                          accounts (after Stripe.js)
//   POST /api/v2/bank/disconnect/{id}    — soft-disconnect an account
//   POST /api/v2/bank/refresh            — manual balance refresh
//   POST /api/v2/bank/sync-transactions  — pull recent txns
//
// Replaces the legacy /bank/stripe/* Flask form-POST endpoints
// that went away in PR #550.

export interface BankConnectResponse {
  clientSecret: string;
  sessionId: string;
  publishableKey: string;
}

export interface BankConnectCompleteResponse {
  accounts_added: number;
  accounts_total: number;
}

export interface BankRefreshResponse {
  accounts_refreshed: number;
  error: string;
}

export interface BankSyncTransactionsResponse {
  new_rows: number;
  total_seen: number;
  error: string;
}

export async function startStripeConnect(): Promise<BankConnectResponse> {
  return api<BankConnectResponse>("/api/v2/bank/connect", {
    method: "POST",
    json: {},
  });
}

export async function completeStripeConnect(
  sessionId: string,
): Promise<BankConnectCompleteResponse> {
  return api<BankConnectCompleteResponse>(
    "/api/v2/bank/connect/complete",
    { method: "POST", json: { sessionId } },
  );
}

export async function disconnectBankAccount(
  accountId: number,
): Promise<void> {
  await api<void>(
    `/api/v2/bank/disconnect/${accountId}`,
    { method: "POST", json: {} },
  );
}

export async function refreshBankBalances(): Promise<BankRefreshResponse> {
  return api<BankRefreshResponse>(
    "/api/v2/bank/refresh",
    { method: "POST", json: {} },
  );
}

export async function syncBankTransactions(): Promise<BankSyncTransactionsResponse> {
  return api<BankSyncTransactionsResponse>(
    "/api/v2/bank/sync-transactions",
    { method: "POST", json: {} },
  );
}

export async function setBankAccountNickname(
  accountId: number, nickname: string,
): Promise<BankAccountRow> {
  return api<BankAccountRow>(
    `/api/v2/bank/accounts/${accountId}/nickname`,
    { method: "PUT", json: { nickname } },
  );
}
