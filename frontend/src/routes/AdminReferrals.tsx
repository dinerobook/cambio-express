
import {
  useReferralCode,
  type ReferralRedemptionRow,
} from "../api/admin";
import { ApiError, apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney, fmtMoney2, fmtNumber } from "../lib/formatters";
import { tn, tNodes, useT } from "../i18n";
import { formatDate } from "../lib/datetime";
import {
  ButtonLink, Card, CopyButton, CopyField, Empty, ErrorState, KpiCard, KpiGrid, Loading,
  Pill, space, Table, tdStyle, thStyle,
} from "../components/ui";
import styles from "./AdminReferrals.module.css";

// Referrals tab content (rendered inside the Settings shell at
// /settings/referrals). Admin self-service for the store's referral
// code: copy-to-clipboard for code + share link, history of
// redemptions, lifetime credits-earned. Paid-plan only — trial
// admins see an upsell card pointing at /app/subscribe.
//
// No PageShell / Breadcrumbs / PageHeader here — the Settings layout
// (Settings.tsx) already provides the page chrome + the tab bar, so
// this component renders bare content to avoid a doubled header +
// nested breadcrumb.

export default function AdminReferrals() {
  const t = useT();
  const identity = getCurrentIdentity();
  const { data, isLoading, isError, error, refetch } = useReferralCode();

  if (identity?.role !== "admin" && identity?.role !== "owner") {
    return (
      <Empty>{t("referral.needAdmin")}</Empty>
    );
  }

  // Trial-plan stores get a 409 with a clear upsell.
  if (isError && error instanceof ApiError && error.status === 409) {
    return (
      <Card>
          <h2 className={styles.cardTitle}>{t("referral.unlockTitle")}</h2>
          <p className={styles.lead}>{t("referral.unlockLead")}</p>
          <ButtonLink to="/subscribe" tone="primary" style={{ marginTop: space.lg }}>
            {t("referral.seePlans")}
          </ButtonLink>
        </Card>
    );
  }

  return (
    <>
      {isLoading && <Loading />}
      {isError && !(error instanceof ApiError && error.status === 409) && (
        <ErrorState
          message={apiErrorMessage(error, t("referral.loadFailed"))}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <>
          <Hero
            code={data.code}
            shareUrl={data.share_url}
            rewardSelfCents={data.reward_self_cents}
            rewardRefereeCents={data.reward_referee_cents}
          />

          <KpiGrid minWidth="180px">
            <KpiCard
              label={t("referral.kpiReferrals")}
              value={fmtNumber(data.redeemed_count)}
              sub={t("referral.kpiReferralsSub")}
              tone="warning"
            />
            <KpiCard
              label={t("referral.kpiCredits")}
              value={fmtMoney2(data.credits_earned_cents / 100)}
              sub={t("referral.kpiCreditsSub")}
              tone="neon"
            />
            <KpiCard
              label={t("referral.kpiStatus")}
              value={data.is_active ? t("referral.active") : t("referral.disabled")}
              sub={data.is_active
                ? t("referral.activeSub")
                : t("referral.disabledSub")}
              tone="primary"
            />
          </KpiGrid>

          <section className={styles.howBox}>
            <strong>{t("referral.howTitle")}</strong>{" "}
            {t("referral.howBody", {
              theirs: fmtMoney(data.reward_referee_cents / 100),
              yours: fmtMoney(data.reward_self_cents / 100),
            })}
          </section>

          <Card>
            <div className={styles.cardHeader}>
              <span>{t("referral.history")}</span>
              <span className={styles.cardHeaderCount}>
                {tn("referral.redemptions", data.redemptions.length, fmtNumber)}
              </span>
            </div>
            <HistoryTable rows={data.redemptions} />
          </Card>
        </>
      )}
    </>
  );
}


function Hero({
  code, shareUrl, rewardSelfCents, rewardRefereeCents,
}: {
  code: string;
  shareUrl: string;
  rewardSelfCents: number;
  rewardRefereeCents: number;
}) {
  const t = useT();
  return (
    <section className={styles.hero}>
      <div className={styles.heroLabel}>{t("referral.yourCode")}</div>
      <div className={styles.heroCode}>{code}</div>
      <p className={styles.heroMeta}>
        {tNodes("referral.heroBody", {
          theirs: <strong>{t("referral.theyGet", { amount: fmtMoney(rewardRefereeCents / 100) })}</strong>,
          yours: <strong>{t("referral.youGet", { amount: fmtMoney(rewardSelfCents / 100) })}</strong>,
        })}
      </p>
      <CopyField
        className={styles.shareRow}
        aria-label={t("referral.shareLinkAria")}
        value={shareUrl}
        copyLabel={t("referral.copyLink")}
        buttonClassName={styles.btnGold}
        actions={(
          <CopyButton
            text={code}
            label={t("referral.copyCode")}
            className={styles.btnGold}
          />
        )}
      />
    </section>
  );
}


function HistoryTable({ rows }: { rows: ReferralRedemptionRow[] }) {
  const t = useT();
  if (rows.length === 0) {
    return (
      <Empty>{t("referral.empty")}</Empty>
    );
  }
  return (
    <Table>
      <thead>
        <tr>
          {[t("referral.colDate"), t("referral.colStore"), t("referral.colYours"), t("referral.colTheirs")].map((h) => (
            <th key={h} style={thStyle}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.referee_store_id}-${r.redeemed_at}`}>
            <td style={tdStyle}>
              <span className={styles.monoMuted}>
                {r.redeemed_at ? formatDate(r.redeemed_at) : "—"}
              </span>
            </td>
            <td style={tdStyle}>#{r.referee_store_id}</td>
            <td style={tdStyle}>
              {r.self_credit_applied ? (
                <>
                  <Pill tone="success">{t("referral.credited")}</Pill>
                  {r.stripe_self_txn_id && (
                    <span className={`${styles.monoMuted} ${styles.txnId}`}>
                      {r.stripe_self_txn_id}
                    </span>
                  )}
                </>
              ) : (
                <Pill tone="warning">{t("referral.pending")}</Pill>
              )}
            </td>
            <td style={tdStyle}>
              {r.referee_credit_applied
                ? <Pill tone="success">{t("referral.credited")}</Pill>
                : <Pill tone="warning">{t("referral.pending")}</Pill>}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
