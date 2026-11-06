// Billing API hooks. Backed by /api/v2/billing/*.
//
// Two write endpoints — both return a Stripe-hosted URL the SPA
// redirects to. The Stripe webhook (`/webhooks/stripe`) is what
// actually flips the store onto the new plan.

import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { PillTone } from "../components/ui";
import { t, type MessageKey } from "../i18n";
import type { components } from "./openapi";

/** Store.plan → Pill tone (UI-STANDARDS §3). A paying plan is live
 *  state (accent); a trial is expiring by definition (warning); an
 *  inactive store is off, which is neutral — red is for failures.
 *  Unknown → neutral. */
export const PLAN_TONES: Record<string, PillTone> = {
  trial:    "warning",
  basic:    "accent",
  pro:      "accent",
  inactive: "neutral",
};

export function planTone(plan: string): PillTone {
  return PLAN_TONES[plan] ?? "neutral";
}

const PLAN_LABELS: Record<string, MessageKey> = {
  trial:    "plan.trial",
  basic:    "plan.basic",
  pro:      "plan.pro",
  inactive: "plan.inactive",
};

/** Store.plan in the reader's language ("trial" → "Prueba"); Basic
 *  and Pro are product names. A plan the SPA doesn't list shows
 *  capitalised, as sent. */
export function planLabel(plan: string): string {
  if (Object.hasOwn(PLAN_LABELS, plan)) return t(PLAN_LABELS[plan]);
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

const CYCLE_LABELS: Record<string, MessageKey> = {
  monthly: "plan.cycle.monthly",
  yearly:  "plan.cycle.yearly",
};

/** Store.billing_cycle in the reader's language; unknown as sent. */
export function billingCycleLabel(cycle: string): string {
  return Object.hasOwn(CYCLE_LABELS, cycle) ? t(CYCLE_LABELS[cycle]) : cycle;
}

export interface CheckoutResponse {
  url: string;
}

export interface PortalResponse {
  url: string;
}

export async function startCheckout(plan: string): Promise<CheckoutResponse> {
  return api<CheckoutResponse>("/api/v2/billing/checkout", {
    method: "POST",
    json: { plan },
  });
}

export async function openBillingPortal(): Promise<PortalResponse> {
  return api<PortalResponse>("/api/v2/billing/portal", {
    method: "POST",
    json: {},
  });
}

export type SubscriptionStore = components["schemas"]["SubscriptionStore"];
export type SubscriptionAddon = components["schemas"]["SubscriptionAddon"];
export type SubscriptionSummary = components["schemas"]["SubscriptionSummaryResponse"];

export async function fetchSubscriptionSummary(): Promise<SubscriptionSummary> {
  return api<SubscriptionSummary>("/api/v2/admin/subscription");
}

export type AddonToggleResponse = components["schemas"]["AddonToggleResponse"];

export async function toggleAddon(
  addonKey: string,
): Promise<AddonToggleResponse> {
  return api<AddonToggleResponse>(
    `/api/v2/admin/addons/${encodeURIComponent(addonKey)}/toggle`,
    { method: "POST", json: {} },
  );
}


// ── Public pricing (W-1) ────────────────────────────────────
//
// The landing page renders before anyone has an account, so this is
// unauthenticated. It reads PLAN_CATALOG server-side rather than
// letting the marketing page keep its own copy of the prices — it
// had one and it drifted, advertising Pro yearly at $420 while
// checkout charged $450.

export type PublicPlan = components["schemas"]["PublicPlan"];

export function usePublicPricing() {
  return useQuery<components["schemas"]["PublicPricingResponse"]>({
    queryKey: ["billing", "public-pricing"],
    queryFn: () => api<components["schemas"]["PublicPricingResponse"]>("/api/v2/billing/pricing"),
    // Prices change about never; don't refetch on every mount.
    staleTime: 60 * 60 * 1000,
  });
}
