import { useEffect, useState } from "react";

import { useStoreInfo } from "../api/account";
import { planLabel } from "../api/billing";
import { getCurrentIdentity } from "../lib/auth";
import { ButtonLink } from "../components/ui";
import styles from "./SubscribeSuccess.module.css";
import { useT } from "../i18n";

// /app/subscribe/success — Stripe Checkout's success_url. Stripe
// redirects here right after the customer pays; the
// checkout.session.completed webhook bumps `Store.plan` to basic
// or pro shortly after (Stripe sends both signals roughly
// simultaneously, but the order isn't guaranteed). When the user
// lands here we may briefly still see plan="trial"; we poll
// store-info every 2s for up to ~30s so the success message
// flips from "Payment received, activating…" to "You're on
// Basic/Pro" without the user having to refresh.

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_TICKS   = 15;  // ~30s total

export default function SubscribeSuccess() {
  const t = useT();
  const identity = getCurrentIdentity();
  const { data, refetch } = useStoreInfo();
  const [ticks, setTicks] = useState(0);

  const plan = data?.store.plan ?? "";
  const activated = plan === "basic" || plan === "pro";

  useEffect(() => {
    if (activated || ticks >= POLL_MAX_TICKS) return;
    const timer = setTimeout(() => {
      refetch();
      setTicks((n) => n + 1);
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [activated, ticks, refetch]);

  if (!identity) {
    return (
      <main className={styles.page}>
        <p className={styles.muted}>{t("subOk.signIn")}</p>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      {activated ? <Activated plan={plan} /> : <Pending />}
    </main>
  );
}


function Activated({ plan }: { plan: string }) {
  const t = useT();
  const label = planLabel(plan);
  return (
    <>
      <div className={`${styles.badge} ${styles.badgeSuccess}`}>
        <Check />
      </div>
      <h1 className={styles.title}>{t("subOk.onPlan", { plan: label })}</h1>
      <p className={styles.lead}>{t("subOk.activeLead", { plan: label })}</p>
      <ButtonLink to="/dashboard" tone="primary">
        {t("subOk.toDashboard")}
      </ButtonLink>
    </>
  );
}


function Pending() {
  const t = useT();
  return (
    <>
      <div className={`${styles.badge} ${styles.badgePending}`}>
        <Clock />
      </div>
      <h1 className={styles.title}>{t("subOk.received")}</h1>
      <p className={styles.lead}>{t("subOk.pendingLead")}</p>
      <div className={styles.actions}>
        <ButtonLink to="/dashboard" tone="primary">
          {t("subOk.toDashboard")}
        </ButtonLink>
      </div>
    </>
  );
}


function Check() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function Clock() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
