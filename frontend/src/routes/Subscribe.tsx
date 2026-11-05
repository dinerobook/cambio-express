import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  fetchSubscriptionSummary, openBillingPortal, startCheckout,
  usePublicPricing, type PublicPlan, type SubscriptionSummary,
} from "../api/billing";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate } from "../lib/datetime";
import { fmtMoney, fmtMoney2 } from "../lib/formatters";
import { tn, useT, type MessageKey, type Translate } from "../i18n";
import { AppLink,
  Alert, Button, Card, Empty, ErrorState, Loading, PageHeader, PageShell, Pill,
} from "../components/ui";
import styles from "./Subscribe.module.css";
import { PageCrumbs } from "../components/PageCrumbs";

// Plan picker at /app/subscribe.  Two flows:
//
//   - Trial / inactive store → each tile POSTs /billing/checkout,
//     redirects to Stripe Checkout.  Webhook flips Store.plan on
//     success.
//   - Already-paid store → the tile it is billed on shows "Current
//     plan" (no Subscribe button), the others swap to "Switch to
//     <plan>" which opens the Stripe Billing Portal (Stripe handles
//     upgrades / downgrades within a single subscription rather
//     than minting a parallel one through Checkout).
//
// Names and prices come from the server's plan catalog
// (/billing/pricing, the same list the landing page shows), never a
// copy here: this file used to carry its own price table, the fifth
// copy of the prices in the codebase.  Which tile is current comes
// from the summary's `plan_key` ("pro_yearly"), because
// `store.plan` is only the tier ("pro") for both cadences — reading
// it marked a yearly store's MONTHLY tile as its plan.

interface PlanTile {
  /** Checkout key: "basic", "basic_yearly", "pro", "pro_yearly". */
  slug: string;
  name: string;
  price: string;
  cadence: string;
  blurb: string;
}

/** What each tier adds, by catalog key. A tier the catalog gains
 *  later shows without a line until it gets one here. */
const TIER_BLURBS: Record<string, MessageKey> = {
  basic: "subscribe.basicBlurb",
  pro: "subscribe.proBlurb",
};

function priceLabel(cents: number): string {
  return cents % 100 === 0 ? fmtMoney(cents / 100) : fmtMoney2(cents / 100);
}

/** Monthly then yearly for each tier, in catalog order. */
function planTiles(plans: PublicPlan[], t: Translate): PlanTile[] {
  return plans.flatMap((p) => {
    const blurbKey = TIER_BLURBS[p.key];
    return [
      {
        slug: p.key,
        name: p.label,
        price: priceLabel(p.monthly_cents),
        cadence: t("subscribe.perMonth"),
        blurb: blurbKey ? t(blurbKey) : "",
      },
      {
        slug: `${p.key}_yearly`,
        name: t("subscribe.yearlyName", { name: p.label }),
        price: priceLabel(p.yearly_cents),
        cadence: t("subscribe.perYear"),
        blurb: p.months_free > 0
          ? tn("subscribe.yearlyBlurb", p.months_free, String, { name: p.label })
          : t("subscribe.yearlyBlurbPlain", { name: p.label }),
      },
    ];
  });
}


export default function Subscribe() {
  const t = useT();
  const identity = getCurrentIdentity();
  // A query, not an effect keyed on `identity`: getCurrentIdentity()
  // hands back a fresh object on every render, so an effect that
  // depended on it refetched (and re-rendered, and refetched …) in a
  // loop, each call a Stripe round-trip on the server.
  const summaryQuery = useQuery({
    queryKey: ["billing", "subscription-summary", identity?.store_id],
    queryFn: fetchSubscriptionSummary,
    enabled: identity != null,
    // Plan picker still renders if the summary fails — it falls back
    // to the no-current-plan view — so don't hammer it with retries.
    retry: false,
  });
  const pricing = usePublicPricing();
  const summary: SubscriptionSummary | null = summaryQuery.data ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (identity == null) {
    return (
      <PageShell maxWidth="62rem">
        <PageHeader title={t("subscribe.title")} />
        <Empty>{t("subscribe.signInFirst")}</Empty>
      </PageShell>
    );
  }

  if (summaryQuery.isLoading || pricing.isLoading) {
    return (
      <PageShell maxWidth="62rem">
        <PageHeader title={t("subscribe.choosePlan")} />
        <Loading />
      </PageShell>
    );
  }

  const tiles = planTiles(pricing.data?.plans ?? [], t);
  const hasPaid = Boolean(summary?.has_paid_plan);
  const cancelling = Boolean(summary?.cancel_at_period_end);
  // Only a paying store has a current tile; a trial's plan_key is
  // "trial", which matches none.
  const currentSlug = hasPaid ? (summary?.plan_key ?? null) : null;
  const currentTile = tiles.find((p) => p.slug === currentSlug);
  // The tile's name is in the reader's language; the server's label
  // is the fallback for a plan the catalog no longer sells.
  const currentName = currentTile?.name ?? summary?.plan_label ?? "";
  const monthsFree = Math.min(
    ...(pricing.data?.plans ?? []).map((p) => p.months_free),
  );

  async function pickPlan(slug: string) {
    setError(null);
    setBusy(slug);
    try {
      if (hasPaid) {
        // Already paid → Stripe handles upgrade/downgrade in the
        // Billing Portal.  Avoids minting a parallel subscription
        // through Checkout.
        const result = await openBillingPortal();
        window.location.assign(result.url);
      } else {
        const result = await startCheckout(slug);
        window.location.assign(result.url);
      }
    } catch (err) {
      setError(
        apiErrorMessage(err, hasPaid
          ? t("subscribe.portalFailed")
          : t("subscribe.checkoutFailed")),
      );
      setBusy(null);
    }
  }

  return (
    <PageShell maxWidth="62rem">

      <PageCrumbs under="/settings" current={t("subscribe.title")} />

      <PageHeader
        title={t("subscribe.choosePlan")}
        subtitle={(
          <>
            {t("subscribe.cancelAnyTime")}{" "}
            <AppLink fallback="text" to="/settings" className={styles.inlineLink}>
              {t("subscribe.settingsLink")}
            </AppLink>.
            {Number.isFinite(monthsFree) && monthsFree > 0 && (
              <> {tn("subscribe.yearlySaves", monthsFree)}</>
            )}
          </>
        )}
      />

      {hasPaid && summary && cancelling && (
        <Alert tone="warning">
          {summary.cancel_at_iso
            ? t("subscribe.cancelledUntil", {
              plan: currentName, date: formatDate(summary.cancel_at_iso),
            })
            : t("subscribe.cancelled", { plan: currentName })}
        </Alert>
      )}
      {hasPaid && summary && !cancelling && (
        <Alert tone="info">
          {summary.comped
            ? t("subscribe.currentComped", { plan: currentName })
            : currentTile
              ? t("subscribe.currentPriced", {
                plan: currentName,
                price: `${currentTile.price} ${currentTile.cadence}`,
              })
              : t("subscribe.current", { plan: currentName })}
        </Alert>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {pricing.isError ? (
        <ErrorState
          message={t("subscribe.plansFailed")}
          onRetry={() => { void pricing.refetch(); }}
          busy={pricing.isFetching}
        />
      ) : (
        <div className={styles.grid}>
          {tiles.map((p) => {
            const isCurrent = currentSlug === p.slug;
            const isCancelledCurrent = isCurrent && cancelling;
            return (
              <Card key={p.slug} padding="1.5rem" className={styles.tile}>
                <div className={styles.tileHeaderRow}>
                  <h2 className={styles.tileTitle}>{p.name}</h2>
                  {isCancelledCurrent && (
                    <Pill tone="warning">{t("subscribe.cancelledPill")}</Pill>
                  )}
                  {isCurrent && !cancelling && (
                    <Pill tone="accent">{t("subscribe.currentPlan")}</Pill>
                  )}
                </div>
                <p className={styles.tilePrice}>
                  <span className={styles.mono}>{p.price}</span>{" "}
                  <span className={styles.cadence}>{p.cadence}</span>
                </p>
                <p className={styles.tileBlurb}>{p.blurb}</p>
                <Button
                  onClick={() => pickPlan(p.slug)}
                  busy={busy === p.slug}
                  disabled={busy !== null || (isCurrent && !cancelling)}
                  tone={(isCurrent && !cancelling) ? "secondary" : "primary"}
                >
                  {isCancelledCurrent ? t("subscribe.resubscribe")
                    : isCurrent ? t("subscribe.currentPlan")
                    : busy === p.slug ? t("subscribe.redirecting")
                    : hasPaid ? t("subscribe.switchTo", { plan: p.name })
                    : t("subscribe.subscribe")}
                </Button>
              </Card>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
