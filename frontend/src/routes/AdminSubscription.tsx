import { useEffect, useState } from "react";

import {
  fetchSubscriptionSummary,
  openBillingPortal,
  toggleAddon,
  type SubscriptionAddon,
  type SubscriptionSummary,
} from "../api/billing";
import { apiErrorMessage } from "../lib/api";
import { AppLink,
  Alert, Button, ButtonLink, Card, ConfirmDialog, ErrorState, Loading,
  PageHeader, PageShell, Pill, Empty,
} from "../components/ui";
import styles from "./AdminSubscription.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { t as translate, tn, tNodes, useT } from "../i18n";

// /app/admin/subscription — current plan hero + account snapshot +
// add-ons grid + cancel modal. Mirrors the legacy
// /admin/subscription Jinja page; reads /api/v2/admin/subscription
// for the page state, calls /api/v2/billing/portal for the
// Manage / Cancel actions, and /api/v2/admin/addons/<key>/toggle
// for add-on flips.
// Plan names are product names: the same in every language.
const PLAN_BASIC = "Basic";
const PLAN_PRO = "Pro";

export default function AdminSubscription() {
  const t = useT();
  const [data, setData] = useState<SubscriptionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCancel, setShowCancel] = useState(false);

  async function load() {
    try {
      setData(await fetchSubscriptionSummary());
    } catch (e) {
      setError(apiErrorMessage(e, translate("adminSub.loadFailed")));
    }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async fetch of subscription summary on mount; load() awaits the API then sets data/error state
    load();
  }, []);

  async function handlePortal(label: string) {
    setBusy(label);
    setError(null);
    try {
      const { url } = await openBillingPortal();
      window.location.assign(url);
    } catch (e) {
      setError(apiErrorMessage(e, t("adminSub.stripeError")));
      setBusy(null);
    }
  }

  async function handleToggle(addon: SubscriptionAddon) {
    setBusy(`addon:${addon.key}`);
    setError(null);
    try {
      await toggleAddon(addon.key);
      await load();
    } catch (e) {
      setError(apiErrorMessage(e, t("adminSub.toggleFailed")));
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) {
    return (
      <PageShell>
        <PageHeader title={t("adminSub.title")} />
        <ErrorState message={error} onRetry={() => { void load(); }} />
      </PageShell>
    );
  }
  if (!data) {
    return (
      <PageShell>
        <PageHeader title={t("adminSub.title")} />
        <Loading />
      </PageShell>
    );
  }

  const { store, has_paid_plan, plan_label, plan_price } = data;
  const inactive = store.plan === "inactive";
  const trial = store.plan === "trial";

  return (
    <PageShell>

      <PageCrumbs under="/settings" current={t("adminSub.title")} />

      <PageHeader title={t("adminSub.title")} />

      {error && <Alert tone="error">{error}</Alert>}

      {inactive && data.retention_days_left != null && (
        <Alert tone="error">
          {tn("adminSub.retention", data.retention_days_left)}
          <AppLink to="/subscribe" className={styles.resubLink}>
            {t("adminSub.resubscribe")}
          </AppLink>
        </Alert>
      )}

      <div className={styles.twoColGrid}>
        <div className={styles.planHero}>
          <div className={styles.planEyebrow}>{t("adminSub.currentPlan")}</div>
          <div className={styles.planName}>{plan_label}</div>
          {plan_price && (
            <div className={styles.planPrice}>{t("adminSub.perStore", { price: plan_price })}</div>
          )}
          {!plan_price && trial && (
            <div className={styles.planPrice}>{t("adminSub.freeTrial")}</div>
          )}

          <div className={styles.planMeta}>
            {trial && data.trial_status === "active" && (
              <>{tn("adminSub.trialActive", data.trial_days_left ?? 0)}</>
            )}
            {trial && data.trial_status === "expiring_soon" && (
              <>{tn("adminSub.trialSoon", data.trial_days_left ?? 0)}</>
            )}
            {trial && data.trial_status === "grace" && (
              <>{t("adminSub.grace")}</>
            )}
            {trial && data.trial_status === "expired" && (
              <>{t("adminSub.expired")}</>
            )}
            {inactive && (
              <>{t("adminSub.inactive")}</>
            )}
            {has_paid_plan && (
              <>{t("adminSub.paid")}</>
            )}
          </div>

          <div className={styles.planActions}>
            {has_paid_plan ? (
              <>
                <Button
                  busy={busy === "portal"}
                  disabled={busy === "portal"}
                  onClick={() => handlePortal("portal")}
                >
                  {busy === "portal" ? t("adminSub.opening") : t("adminSub.manage")}
                </Button>
                <ButtonLink to="/subscribe" tone="secondary">{t("adminSub.changePlan")}</ButtonLink>
              </>
            ) : (
              <ButtonLink to="/subscribe" tone="primary">{t("adminSub.choosePlan")}</ButtonLink>
            )}
          </div>
          {has_paid_plan && (
            <Button
              tone="ghost"
              className={styles.cancelLink}
              onClick={() => { setError(null); setShowCancel(true); }}
            >
              {t("adminSub.cancel")}
            </Button>
          )}
        </div>

        <Card>
          <h3 className={styles.cardH3}>{t("adminSub.account")}</h3>
          <InfoRow label={t("adminSub.store")} value={store.name || "—"} />
          <InfoRow label={t("adminSub.billingEmail")} value={store.email || "—"} />
          <InfoRow
            label={t("adminSub.customerId")}
            value={store.stripe_customer_id || "—"}
            mono
          />
          <InfoRow
            label={t("adminSub.subscriptionId")}
            value={store.stripe_subscription_id || "—"}
            mono
          />
          <InfoRow label={t("adminSub.activeAddons")} value={String(data.active_addon_count)} />
        </Card>
      </div>

      <h2 className={styles.addonsHeading}>{t("adminSub.addons")}</h2>

      {!has_paid_plan && (
        <div className={styles.bannerWarn}>
          {tNodes("adminSub.needsPlan", {
            basic: <strong>{PLAN_BASIC}</strong>,
            pro: <strong>{PLAN_PRO}</strong>,
            link: (
              <AppLink to="/subscribe" style={{ color: "inherit", textDecoration: "underline" }}>
                {t("adminSub.choosePlan")}
              </AppLink>
            ),
          })}
        </div>
      )}

      <div className={styles.addonGrid}>
        {data.addons.map((a) => (
          <Card key={a.key} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div className={styles.addonRow}>
              <div>
                <div className={styles.addonName}>{a.name}</div>
                <div className={styles.muted}>{a.tagline}</div>
              </div>
              <div className={styles.addonRowEnd}>
                {a.status === "coming_soon" && (
                  <Pill tone="warning">{t("adminSub.comingSoon")}</Pill>
                )}
                <span className={styles.addonPrice}>{a.price_label}</span>
              </div>
            </div>
            <p className={styles.addonDesc}>{a.description}</p>
            <div className={styles.addonFoot}>
              <span className={styles.muted}>
                {a.is_active ? <Pill tone="accent">{t("adminSub.active")}</Pill> : t("adminSub.notAdded")}
              </span>
              <Button
                tone="secondary"
                size="sm"
                className={styles.btnLinkLive}
                disabled={
                  busy === `addon:${a.key}` ||
                  (!has_paid_plan && a.status !== "coming_soon")
                }
                onClick={() => handleToggle(a)}
              >
                {a.status === "coming_soon"
                  ? t("adminSub.notify")
                  : a.is_active
                    ? t("adminSub.remove")
                    : t("adminSub.add")}
              </Button>
            </div>
          </Card>
        ))}
        {data.addons.length === 0 && (
          <Empty>{t("adminSub.noAddons")}</Empty>
        )}
      </div>

      <ConfirmDialog
        open={showCancel && has_paid_plan}
        title={t("adminSub.beforeCancel")}
        message={
          <>
            <p style={{ marginTop: 0 }}>
              {tNodes("adminSub.cancelLead", { plan: <strong>{plan_label}</strong> })}
            </p>
            <div className={styles.infoBox}>
              <strong>{t("adminSub.safeTitle")}</strong>
              <br />
              {t("adminSub.safeBody")}
            </div>
            <p className={styles.muted} style={{ marginBottom: 0 }}>
              {t("adminSub.toStripe")}
            </p>
          </>
        }
        confirmLabel={busy === "cancel" ? t("adminSub.opening") : t("adminSub.continueCancel")}
        cancelLabel={t("adminSub.keep")}
        confirmTone="danger"
        busy={busy === "cancel"}
        // While the dialog is open the page behind is covered: a
        // failed hand-off to Stripe must show in here.
        error={showCancel ? error : null}
        onConfirm={() => handlePortal("cancel")}
        onCancel={() => setShowCancel(false)}
      />
    </PageShell>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.infoRow}>
      <span className={styles.muted}>{label}</span>
      <span className={mono ? styles.monoSm : undefined}>
        {value}
      </span>
    </div>
  );
}
