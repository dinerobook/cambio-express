import { useQuery } from "@tanstack/react-query";

import { api, apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Card,
  ErrorState,
  Loading,
  PageHeader,
  PageShell,
  Pill,
  Section,
} from "../components/ui";
import styles from "./SuperadminHealth.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import type { components } from "../api/openapi";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

type HealthData = components["schemas"]["SuperadminSystemHealthResponse"];

// Product and setting names read the same in every language.
const STRIPE = "Stripe";
const PYTHON = "Python";
const WEBAUTHN_RP_ID = "WebAuthn RP ID";
const ENV_DATABASE_URL = "DATABASE_URL";
const ENV_SECRET_KEY = "SECRET_KEY";
const ENV_SENTRY_DSN = "SENTRY_DSN";

function useSystemHealth() {
  const identity = getCurrentIdentity();
  return useQuery<HealthData>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "system-health"],
    queryFn: () => api<HealthData>("/api/v2/superadmin/system-health"),
  });
}

function Dot({ status }: { status: "ok" | "error" | "warn" | "muted" }) {
  const cls = status === "ok" ? styles.dotOk
    : status === "error" ? styles.dotError
    : status === "warn" ? styles.dotWarn
    : styles.dotMuted;
  return <span className={cls} />;
}

function Row({ label, value, status }: {
  label: string;
  value: React.ReactNode;
  status?: "ok" | "error" | "warn" | "muted";
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>
        {status && <Dot status={status} />}
        {label}
      </span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  );
}

export default function SuperadminHealth() {
  const t = useT();
  const { data, isLoading, isError, error, refetch } = useSystemHealth();

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />

      <PageHeader
        title={navWord("Health")}
        subtitle={t("saHealth.subtitle")}
      />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={apiErrorMessage(error, t("saHealth.loadFailed"))}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <>
          <div className={styles.grid}>
            <Section title={t("saHealth.database")}>
              <Card>
                <Row
                  label={t("saHealth.connection")}
                  value={data.db.ok ? t("saHealth.connected") : t("saHealth.error")}
                  status={data.db.ok ? "ok" : "error"}
                />
                {data.db.error && (
                  <div className={styles.errorText}>{data.db.error}</div>
                )}
                <Row label={t("saHealth.totalStores")} value={fmtNumber(data.db.total_stores)} />
                <Row label={t("saHealth.totalUsers")} value={fmtNumber(data.db.total_users)} />
                <Row label={t("saHealth.totalTransfers")} value={fmtNumber(data.db.total_transfers)} />
              </Card>
            </Section>

            <Section title={STRIPE}>
              <Card>
                <Row
                  label={t("saHealth.apiConnection")}
                  value={data.stripe.ok ? t("saHealth.connected") : t("saHealth.notConnected")}
                  status={data.stripe.ok ? "ok" : "error"}
                />
                {data.stripe.error && (
                  <div className={styles.errorText}>{data.stripe.error}</div>
                )}
                {data.stripe.ok && (
                  <>
                    <Row label={t("saHealth.account")} value={data.stripe.account_id ?? "—"} />
                    <Row
                      label={t("saHealth.mode")}
                      value={
                        <Pill tone={data.stripe.mode === "live" ? "success" : "warning"}>
                          {data.stripe.mode ?? t("saHealth.unknown")}
                        </Pill>
                      }
                    />
                    <Row
                      label={t("saHealth.keyPair")}
                      value={data.stripe.key_pair_match ? t("common.yes") : t("saHealth.mismatch")}
                      status={data.stripe.key_pair_match ? "ok" : "error"}
                    />
                    <Row
                      label={t("saHealth.fc")}
                      value={data.stripe.fc_ok ? t("saHealth.enabled") : t("saHealth.notAvailable")}
                      status={data.stripe.fc_ok ? "ok" : "muted"}
                    />
                  </>
                )}
                <div style={{ marginTop: "0.5rem" }}>
                  {Object.entries(data.stripe.env || {}).map(([key, set]) => (
                    <Row
                      key={key}
                      label={key}
                      value={set ? t("saHealth.set") : t("saHealth.missing")}
                      status={set ? "ok" : "warn"}
                    />
                  ))}
                </div>
                {data.stripe.price_ok && (
                  <div style={{ marginTop: "0.5rem" }}>
                    {Object.entries(data.stripe.price_ok).map(([plan, ok]) => (
                      <Row
                        key={plan}
                        label={t("saHealth.price", { plan })}
                        value={ok ? t("saHealth.valid") : t("saHealth.invalid")}
                        status={ok ? "ok" : "warn"}
                      />
                    ))}
                  </div>
                )}
              </Card>
            </Section>
          </div>

          <div className={styles.grid}>
            <Section title={t("saHealth.email")}>
              <Card>
                <Row
                  label={t("saHealth.smtp")}
                  value={data.email.configured ? t("common.yes") : t("common.no")}
                  status={data.email.configured ? "ok" : "warn"}
                />
                {data.email.status && (
                  <Row
                    label={t("saHealth.lastSend")}
                    value={data.email.status}
                    status={data.email.status === "ok" ? "ok" : "warn"}
                  />
                )}
                {data.email.error && (
                  <div className={styles.errorText}>{data.email.error}</div>
                )}
                {data.email.recent_events && (
                  <>
                    {Object.entries(data.email.recent_events).map(([evt, count]) => (
                      <Row key={evt} label={t("saHealth.recent", { event: evt })} value={fmtNumber(count)} />
                    ))}
                  </>
                )}
                <Row
                  label={t("saHealth.suppressed")}
                  value={data.email.suppressed_count ?? 0}
                  status={(data.email.suppressed_count ?? 0) > 0 ? "warn" : "ok"}
                />
              </Card>
            </Section>

            <Section title={t("saHealth.infra")}>
              <Card>
                <Row
                  label={t("saHealth.queue")}
                  value={data.queue.enabled ? t("saHealth.queueOn") : t("saHealth.queueSync")}
                  status={data.queue.enabled ? "ok" : "muted"}
                />
                <Row
                  label={t("saHealth.redis")}
                  value={data.queue.redis_configured ? t("common.yes") : t("common.no")}
                  status={data.queue.redis_configured ? "ok" : "muted"}
                />
                <Row
                  label={t("saHealth.rateLimit")}
                  value={data.rate_limiting.enabled ? t("saHealth.enabled") : t("saHealth.disabled")}
                  status={data.rate_limiting.enabled ? "ok" : "warn"}
                />
              </Card>
            </Section>
          </div>

          <Section title={t("saHealth.environment")}>
            <Card>
              <div className={styles.envGrid}>
                <Row label={PYTHON} value={data.env.python_version} />
                <Row label={t("saHealth.platform")} value={data.env.platform} />
                <Row label={t("saHealth.serverTime")} value={data.env.server_time.slice(0, 19)} />
                <Row
                  label={ENV_DATABASE_URL}
                  value={data.env.database_url_set ? t("saHealth.set") : t("saHealth.missing")}
                  status={data.env.database_url_set ? "ok" : "error"}
                />
                <Row
                  label={ENV_SECRET_KEY}
                  value={data.env.secret_key_set ? t("saHealth.set") : t("saHealth.missing")}
                  status={data.env.secret_key_set ? "ok" : "error"}
                />
                <Row
                  label={ENV_SENTRY_DSN}
                  value={data.env.sentry_dsn_set ? t("saHealth.set") : t("saHealth.notSet")}
                  status={data.env.sentry_dsn_set ? "ok" : "muted"}
                />
                <Row label={WEBAUTHN_RP_ID} value={data.env.webauthn_rp_id} />
              </div>
            </Card>
          </Section>
        </>
      )}
    </PageShell>
  );
}
