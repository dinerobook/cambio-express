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

type HealthData = components["schemas"]["SuperadminSystemHealthResponse"];

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
  const { data, isLoading, isError, error, refetch } = useSystemHealth();

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />

      <PageHeader
        title="Health"
        subtitle="Real-time platform infrastructure status"
      />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={apiErrorMessage(error, "Could not load health data")}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <>
          <div className={styles.grid}>
            <Section title="Database">
              <Card>
                <Row
                  label="Connection"
                  value={data.db.ok ? "Connected" : "Error"}
                  status={data.db.ok ? "ok" : "error"}
                />
                {data.db.error && (
                  <div className={styles.errorText}>{data.db.error}</div>
                )}
                <Row label="Total stores" value={fmtNumber(data.db.total_stores)} />
                <Row label="Total users" value={fmtNumber(data.db.total_users)} />
                <Row label="Total transfers" value={fmtNumber(data.db.total_transfers)} />
              </Card>
            </Section>

            <Section title="Stripe">
              <Card>
                <Row
                  label="API connection"
                  value={data.stripe.ok ? "Connected" : "Not connected"}
                  status={data.stripe.ok ? "ok" : "error"}
                />
                {data.stripe.error && (
                  <div className={styles.errorText}>{data.stripe.error}</div>
                )}
                {data.stripe.ok && (
                  <>
                    <Row label="Account" value={data.stripe.account_id ?? "—"} />
                    <Row
                      label="Mode"
                      value={
                        <Pill tone={data.stripe.mode === "live" ? "success" : "warning"}>
                          {data.stripe.mode ?? "unknown"}
                        </Pill>
                      }
                    />
                    <Row
                      label="Key pair match"
                      value={data.stripe.key_pair_match ? "Yes" : "MISMATCH"}
                      status={data.stripe.key_pair_match ? "ok" : "error"}
                    />
                    <Row
                      label="Financial connections"
                      value={data.stripe.fc_ok ? "Enabled" : "Not available"}
                      status={data.stripe.fc_ok ? "ok" : "muted"}
                    />
                  </>
                )}
                <div style={{ marginTop: "0.5rem" }}>
                  {Object.entries(data.stripe.env || {}).map(([key, set]) => (
                    <Row
                      key={key}
                      label={key}
                      value={set ? "Set" : "Missing"}
                      status={set ? "ok" : "warn"}
                    />
                  ))}
                </div>
                {data.stripe.price_ok && (
                  <div style={{ marginTop: "0.5rem" }}>
                    {Object.entries(data.stripe.price_ok).map(([plan, ok]) => (
                      <Row
                        key={plan}
                        label={`Price: ${plan}`}
                        value={ok ? "Valid" : "Invalid"}
                        status={ok ? "ok" : "warn"}
                      />
                    ))}
                  </div>
                )}
              </Card>
            </Section>
          </div>

          <div className={styles.grid}>
            <Section title="Email / SMTP">
              <Card>
                <Row
                  label="SMTP configured"
                  value={data.email.configured ? "Yes" : "No"}
                  status={data.email.configured ? "ok" : "warn"}
                />
                {data.email.status && (
                  <Row
                    label="Last send"
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
                      <Row key={evt} label={`7d ${evt}`} value={fmtNumber(count)} />
                    ))}
                  </>
                )}
                <Row
                  label="Suppressed addresses"
                  value={data.email.suppressed_count ?? 0}
                  status={(data.email.suppressed_count ?? 0) > 0 ? "warn" : "ok"}
                />
              </Card>
            </Section>

            <Section title="Infrastructure">
              <Card>
                <Row
                  label="Job queue"
                  value={data.queue.enabled ? "Enabled (Redis)" : "Sync mode"}
                  status={data.queue.enabled ? "ok" : "muted"}
                />
                <Row
                  label="Redis configured"
                  value={data.queue.redis_configured ? "Yes" : "No"}
                  status={data.queue.redis_configured ? "ok" : "muted"}
                />
                <Row
                  label="Rate limiting"
                  value={data.rate_limiting.enabled ? "Enabled" : "Disabled"}
                  status={data.rate_limiting.enabled ? "ok" : "warn"}
                />
              </Card>
            </Section>
          </div>

          <Section title="Environment">
            <Card>
              <div className={styles.envGrid}>
                <Row label="Python" value={data.env.python_version} />
                <Row label="Platform" value={data.env.platform} />
                <Row label="Server time (UTC)" value={data.env.server_time.slice(0, 19)} />
                <Row
                  label="DATABASE_URL"
                  value={data.env.database_url_set ? "Set" : "Missing"}
                  status={data.env.database_url_set ? "ok" : "error"}
                />
                <Row
                  label="SECRET_KEY"
                  value={data.env.secret_key_set ? "Set" : "Missing"}
                  status={data.env.secret_key_set ? "ok" : "error"}
                />
                <Row
                  label="SENTRY_DSN"
                  value={data.env.sentry_dsn_set ? "Set" : "Not set"}
                  status={data.env.sentry_dsn_set ? "ok" : "muted"}
                />
                <Row label="WebAuthn RP ID" value={data.env.webauthn_rp_id} />
              </div>
            </Card>
          </Section>
        </>
      )}
    </PageShell>
  );
}
