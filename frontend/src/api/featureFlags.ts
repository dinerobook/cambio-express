import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { components } from "./openapi";

// ── Feature Flags ───────────────────────────────────────────

export type FeatureFlagRow = components["schemas"]["FeatureFlagRow"];

interface FeatureFlagListResponse {
  rows: FeatureFlagRow[];
  total: number;
}

interface FeatureFlagResponse {
  flag: FeatureFlagRow;
}

export function useFeatureFlags() {
  return useQuery<FeatureFlagListResponse>({
    queryKey: ["feature-flags"],
    queryFn: () => api<FeatureFlagListResponse>("/api/v2/feature-flags"),
  });
}

export async function createFeatureFlag(body: {
  key: string;
  label?: string;
  description?: string;
  enabled_by_default?: boolean;
}): Promise<FeatureFlagResponse> {
  return api<FeatureFlagResponse>("/api/v2/feature-flags", {
    method: "POST",
    json: body,
  });
}

export async function toggleFeatureFlag(
  key: string,
  enabled_by_default: boolean,
): Promise<FeatureFlagResponse> {
  return api<FeatureFlagResponse>(`/api/v2/feature-flags/${key}/toggle`, {
    method: "POST",
    json: { enabled_by_default },
  });
}

export async function deleteFeatureFlag(key: string): Promise<void> {
  await api(`/api/v2/feature-flags/${key}`, { method: "DELETE" });
}

// ── Store Overrides ─────────────────────────────────────────

export type StoreOverrideRow = components["schemas"]["StoreOverrideRow"];

interface StoreOverrideListResponse {
  rows: StoreOverrideRow[];
  total: number;
}

interface StoreOverrideResponse {
  override: StoreOverrideRow;
}

export function useStoreOverrides(flagKey: string) {
  return useQuery<StoreOverrideListResponse>({
    enabled: !!flagKey,
    queryKey: ["feature-flag-overrides", flagKey],
    queryFn: () =>
      api<StoreOverrideListResponse>(
        `/api/v2/feature-flags/${flagKey}/overrides`,
      ),
  });
}

export async function setStoreOverride(
  key: string,
  storeId: number,
  enabled: boolean,
): Promise<StoreOverrideResponse> {
  return api<StoreOverrideResponse>(
    `/api/v2/feature-flags/${key}/stores/${storeId}`,
    { method: "PUT", json: { enabled } },
  );
}

export async function clearStoreOverride(
  key: string,
  storeId: number,
): Promise<void> {
  await api(`/api/v2/feature-flags/${key}/stores/${storeId}`, {
    method: "DELETE",
  });
}

// ── Discounts ───────────────────────────────────────────────

export type DiscountCodeRow = components["schemas"]["DiscountCodeRow"];

interface DiscountCodeListResponse {
  rows: DiscountCodeRow[];
  total: number;
}

interface DiscountCodeResponse {
  discount: DiscountCodeRow;
}

export function useDiscounts() {
  return useQuery<DiscountCodeListResponse>({
    queryKey: ["superadmin-discounts"],
    queryFn: () =>
      api<DiscountCodeListResponse>("/api/v2/superadmin/discounts"),
  });
}

export async function toggleDiscount(
  discountId: number,
  isActive: boolean,
): Promise<DiscountCodeResponse> {
  return api<DiscountCodeResponse>(
    `/api/v2/superadmin/discounts/${discountId}/toggle`,
    { method: "POST", json: { is_active: isActive } },
  );
}
