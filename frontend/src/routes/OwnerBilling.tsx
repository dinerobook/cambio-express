import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useOwnerBilling, type OwnerBillingRow } from "../api/owner";
import { switchStore } from "../api/switchStore";
import {
  Button, Card, Empty, KpiCard, KpiGrid, monoStyle,
  PageHeader, PageShell, Pill, Section, Table, TableStates, tdStyle,
  thStyle, type PillTone,
} from "../components/ui";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney2 } from "../lib/formatters";
import styles from "./OwnerBilling.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/owner/billing — every store's subscription state in one
// place (B-1).
//
// Subscriptions are per-store, which is fine for Stripe but left a
// multi-store owner with no way to answer "what am I paying in
// total, and is anything about to lapse?" without switching into
// each store in turn. This page answers both, and the per-row
// action does that switch for them: hop into the store and land on
// its subscription page, where its Stripe customer actually lives.

// Attention slugs from the API, mapped to wording + a pill tone.
// Tones follow UI-STANDARDS section 3: negative = failed/urgent,
// warning = pending action, neutral = nothing to do.
const ATTENTION: Record<string, { label: MessageKey; tone: PillTone }> = {
  retention:     { label: "ownerBill.purgingSoon",  tone: "negative" },
  trial_expired: { label: "ownerBill.trialExpired", tone: "negative" },
  inactive:      { label: "ownerBill.inactive",     tone: "negative" },
  trial_ending:  { label: "ownerBill.trialEnding",  tone: "warning" },
};

function statusFor(row: OwnerBillingRow): { label: MessageKey; tone: PillTone } {
  const flagged = Object.hasOwn(ATTENTION, row.attention)
    ? ATTENTION[row.attention] : null;
  if (flagged) return flagged;
  if (row.has_paid_plan) return { label: "ownerBill.active", tone: "accent" };
  if (row.plan === "trial") return { label: "ownerBill.trial", tone: "info" };
  return { label: "ownerBill.inactive", tone: "neutral" };
}

/** The detail line under a store's status — why it needs attention,
 *  or when its trial runs out. Empty for a healthy paid store. */
function detailFor(row: OwnerBillingRow): string {
  if (row.retention_days_left != null) {
    return row.retention_days_left === 0
      ? t("ownerBill.purgesToday")
      : tn("ownerBill.purgesIn", row.retention_days_left);
  }
  if (row.plan === "trial" && row.trial_days_left != null) {
    return row.trial_days_left === 0
      ? t("ownerBill.trialEndsToday")
      : tn("ownerBill.daysLeft", row.trial_days_left);
  }
  if (row.plan === "inactive") return t("ownerBill.noSubscription");
  return "";
}

export default function OwnerBilling() {
  useT(); // re-render on a language switch
  const identity = getCurrentIdentity();
  const navigate = useNavigate();
  const toastApiError = useApiErrorToast();
  const [busyId, setBusyId] = useState<number | null>(null);
  const { data, isLoading, isError, error, refetch } = useOwnerBilling();

  const isOwner =
    identity?.role === "owner" || identity?.role === "superadmin";
  // Superadmin can READ the rollup (support / debug), but
  // /auth/switch-store is owner-only by design — offering them a
  // button that can only 403 is worse than not offering it. They
  // reach a store through the superadmin store drill-down instead.
  const canSwitch = identity?.role === "owner";

  async function manageStore(row: OwnerBillingRow) {
    setBusyId(row.store_id);
    try {
      await switchStore(row.store_id);
      // Land on the page that can actually act: a store with no
      // paid plan needs the plan picker, one with a plan needs the
      // Stripe portal on its subscription page.
      navigate(row.has_paid_plan ? "/admin/subscription" : "/subscribe");
    } catch (err) {
      toastApiError(err, t("ownerBill.openFailed"));
      setBusyId(null);
    }
  }

  if (!isOwner) {
    return (
      <PageShell>
        <PageHeader title={navWord("Billing")} />
        <Empty>{t("ownerBill.signIn")}</Empty>
      </PageShell>
    );
  }

  const totals = data?.totals;
  const rows = data?.rows ?? [];

  return (
    <PageShell>
      <PageCrumbs />
      <PageHeader
        title={navWord("Billing")}
        subtitle={t("ownerBill.subtitle")}
      />

      {totals && (
        <KpiGrid>
          <KpiCard
            label={t("ownerBill.monthlyTotal")}
            value={fmtMoney2(totals.monthly_cost + totals.addon_monthly_cost)}
            sub={
              totals.addon_monthly_cost > 0
                ? t("ownerBill.plansPlusAddons", {
                  plans: fmtMoney2(totals.monthly_cost),
                  addons: fmtMoney2(totals.addon_monthly_cost),
                })
                : t("ownerBill.yearlyPerMonth")
            }
          />
          <KpiCard
            label={t("ownerBill.paidStores")}
            value={String(totals.paid_stores)}
            sub={t("ownerBill.ofTotal", { count: totals.stores })}
          />
          <KpiCard
            label={t("ownerBill.onTrial")}
            value={String(totals.trial_stores)}
          />
          <KpiCard
            label={t("ownerBill.needsAttention")}
            value={String(totals.attention_count)}
            tone={totals.attention_count > 0 ? "negative" : "neutral"}
          />
        </KpiGrid>
      )}

      <Card>
        <Section title={t("ownerBill.stores")}>
          <TableStates
            isLoading={isLoading} isError={isError} error={error}
            isEmpty={rows.length === 0}
            onRetry={() => { void refetch(); }}
            emptyTitle={t("ownerBill.noStores")}
            emptyBody={t("ownerBill.noStoresBody")}
          />
          {rows.length > 0 && (
            <div className={styles.tableWrap}>
              <Table>
                <thead>
                  <tr>
                    <th style={thStyle}>{t("ownerBill.colStore")}</th>
                    <th style={thStyle}>{t("ownerBill.colStatus")}</th>
                    <th style={thStyle}>{t("ownerBill.colPlan")}</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>
                      {t("ownerBill.colPerMonth")}
                    </th>
                    <th style={thStyle}>{t("ownerBill.colAddons")}</th>
                    <th style={thStyle} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const status = statusFor(r);
                    const detail = detailFor(r);
                    return (
                      <tr key={r.store_id}>
                        <td style={tdStyle}>{r.store_name}</td>
                        <td style={tdStyle}>
                          <Pill tone={status.tone}>{t(status.label)}</Pill>
                          {detail && (
                            <div className={styles.detail}>{detail}</div>
                          )}
                        </td>
                        <td style={tdStyle}>
                          {r.plan_label}
                          {r.plan_price_label && (
                            <div className={styles.detail}>
                              {r.plan_price_label}
                            </div>
                          )}
                        </td>
                        <td style={{ ...tdStyle, ...monoStyle, textAlign: "right" }}>
                          {r.monthly_cost > 0 ? fmtMoney2(r.monthly_cost) : "—"}
                        </td>
                        <td style={tdStyle}>
                          {r.addon_count > 0
                            ? `${r.addon_count} · ${fmtMoney2(r.addon_monthly_cost)}`
                            : "—"}
                        </td>
                        <td style={tdStyle}>
                          {canSwitch && (
                            <Button
                              tone="secondary" size="sm"
                              busy={busyId === r.store_id}
                              disabled={busyId != null}
                              onClick={() => { void manageStore(r); }}
                            >
                              {busyId === r.store_id
                                ? t("ownerBill.opening")
                                : r.has_paid_plan
                                  ? t("ownerBill.manage")
                                  : t("ownerBill.subscribe")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          )}
        </Section>
        <p className={styles.footnote}>{t("ownerBill.footnote")}</p>
      </Card>
    </PageShell>
  );
}
