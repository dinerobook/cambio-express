import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  clearStoreRetention,
  retentionDryRun,
  type RetentionDryRunResponse,
} from "../api/superadmin";
import { api, apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate } from "../lib/datetime";
import { planLabel } from "../api/billing";
import {
  Alert, Button, Card, ConfirmDialog, EmptyState,
  ErrorState, KpiCard, KpiGrid, Loading, PageHeader, PageShell, Pill,
  Section, useToast,
} from "../components/ui";
import styles from "./SuperadminBilling.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import type { components } from "../api/openapi";
import { tn, tNodes, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// The purge job's name, as an operator greps for it.
const PURGE_JOB = "purge_expired_stores";

type BillingData = components["schemas"]["SuperadminBillingOverviewResponse"];

function useBillingOverview() {
  const identity = getCurrentIdentity();
  return useQuery<BillingData>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "billing-overview"],
    queryFn: () => api<BillingData>("/api/v2/superadmin/billing-overview"),
  });
}

export default function SuperadminBilling() {
  const t = useT();
  const { data, isLoading, isError, error, refetch } = useBillingOverview();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [dryRun, setDryRun] = useState<RetentionDryRunResponse | null>(null);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [clearTarget, setClearTarget] = useState<{
    storeId: number; name: string;
  } | null>(null);
  const [clearBusy, setClearBusy] = useState(false);

  async function runDryRun() {
    setDryRunBusy(true);
    setDryRunError(null);
    try {
      const res = await retentionDryRun();
      setDryRun(res);
    } catch (err) {
      setDryRunError(
        apiErrorMessage(err, t("saBill.dryRunFailed")),
      );
    } finally {
      setDryRunBusy(false);
    }
  }

  async function doClearRetention() {
    if (clearTarget == null) return;
    setClearBusy(true);
    try {
      await clearStoreRetention(clearTarget.storeId);
      toast({
        message: t("saBill.cleared", { name: clearTarget.name }),
        tone: "success",
      });
      setClearTarget(null);
      void refetch();
      // Re-run the dry-run if one is showing so the table reflects the
      // change.
      if (dryRun) await runDryRun();
    } catch (err) {
      toastApiError(err, t("saBill.failed"));
    } finally {
      setClearBusy(false);
    }
  }

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title={navWord("Billing")}
        subtitle={t("saBill.subtitle")}
      />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={apiErrorMessage(error, t("saBill.loadFailed"))}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <>
          <KpiGrid>
            <KpiCard
              label={t("saBill.expiringSoon")}
              value={data.expiring_soon.length}
              tone={data.expiring_soon.length > 0 ? "warning" : "neutral"}
            />
            <KpiCard
              label={t("saBill.inGrace")}
              value={data.in_grace.length}
              tone={data.in_grace.length > 0 ? "warning" : "neutral"}
            />
            <KpiCard
              label={t("saCtl.retention")}
              value={data.retention_queue.length}
              tone={data.retention_queue.length > 0 ? "negative" : "neutral"}
            />
            <KpiCard
              label={t("saBill.cancels30")}
              value={data.recent_cancels.length}
              tone={data.recent_cancels.length > 0 ? "negative" : "positive"}
            />
          </KpiGrid>

          <div className={styles.grid}>
            <Section title={t("saBill.trialsExpiring")}>
              <Card>
                {data.expiring_soon.length === 0 ? (
                  <EmptyState title={t("saBill.noTrials")} />
                ) : (
                  data.expiring_soon.map((s) => (
                    <div key={s.store_id} className={styles.storeRow}>
                      <div>
                        <div className={styles.storeName}>{s.name}</div>
                        <div className={styles.storeMeta}>{s.slug} · {s.email}</div>
                      </div>
                      <div className={styles.badge}>
                        <Pill tone="warning">
                          {t("saBill.ends", { date: formatDate(s.trial_ends_at) })}
                        </Pill>
                      </div>
                    </div>
                  ))
                )}
              </Card>
            </Section>

            <Section title={t("saBill.inGrace")}>
              <Card>
                {data.in_grace.length === 0 ? (
                  <EmptyState title={t("saBill.noGrace")} />
                ) : (
                  data.in_grace.map((s) => (
                    <div key={s.store_id} className={styles.storeRow}>
                      <div>
                        <div className={styles.storeName}>{s.name}</div>
                        <div className={styles.storeMeta}>{s.slug}</div>
                      </div>
                      <div className={styles.badge}>
                        <Pill tone="warning">
                          {t("saBill.graceEnds", { date: formatDate(s.grace_ends_at) })}
                        </Pill>
                      </div>
                    </div>
                  ))
                )}
              </Card>
            </Section>
          </div>

          <div className={styles.grid}>
            <Section title={t("saBill.queueTitle")}>
              <Card>
                {data.retention_queue.length === 0 ? (
                  <EmptyState title={t("saBill.noQueue")} />
                ) : (
                  data.retention_queue.map((s) => (
                    <div key={s.store_id} className={styles.storeRow}>
                      <div>
                        <div className={styles.storeName}>{s.name}</div>
                        <div className={styles.storeMeta}>{s.slug}</div>
                      </div>
                      <div className={styles.badge}>
                        <Button
                          size="sm"
                          tone="secondary"
                          onClick={() => setClearTarget({
                            storeId: s.store_id, name: s.name,
                          })}
                        >
                          {t("saBill.pause")}
                        </Button>
                        <Pill tone="negative">
                          {s.days_left == null ? "—" : tn("saBill.daysLeft", s.days_left, fmtNumber)}
                        </Pill>
                      </div>
                    </div>
                  ))
                )}
              </Card>
            </Section>

            <Section title={t("saBill.recentCancels")}>
              <Card>
                {data.recent_cancels.length === 0 ? (
                  <EmptyState title={t("saBill.noCancels")} />
                ) : (
                  data.recent_cancels.map((s) => (
                    <div key={s.store_id} className={styles.storeRow}>
                      <div>
                        <div className={styles.storeName}>{s.name}</div>
                        <div className={styles.storeMeta}>{s.slug} · {planLabel(s.plan)}</div>
                      </div>
                      <span className={styles.monoMuted}>
                        {formatDate(s.canceled_at)}
                      </span>
                    </div>
                  ))
                )}
              </Card>
            </Section>
          </div>

          {Object.keys(data.webhook_stats).length > 0 && (
            <Section title={t("saBill.webhooks")}>
              <Card>
                <KpiGrid minWidth="120px">
                  {Object.entries(data.webhook_stats).map(([status, count]) => (
                    <KpiCard
                      key={status}
                      label={status}
                      value={count}
                      tone={status === "ok" ? "positive" : "negative"}
                    />
                  ))}
                </KpiGrid>
              </Card>
            </Section>
          )}

          <Section title={t("saBill.dryRunTitle")}>
            <Card>
              <p className={styles.dryRunIntro}>
                {tNodes("saBill.dryRunIntro", { job: <code>{PURGE_JOB}</code> })}
              </p>
              <div className={styles.dryRunActions}>
                <Button
                  size="sm"
                  onClick={() => { void runDryRun(); }}
                  disabled={dryRunBusy}
                >
                  {dryRunBusy
                    ? t("saBill.running")
                    : (dryRun ? t("saBill.refresh") : t("saBill.preview"))}
                </Button>
                {dryRun && (
                  <span className={styles.dryRunSummary}>
                    {tn("saBill.wouldDelete", dryRun.store_count, fmtNumber, {
                      rows: tn("saBill.childRows", dryRun.total_child_rows, fmtNumber),
                    })}
                  </span>
                )}
              </div>
              {dryRunError && (
                <Alert tone="error">{dryRunError}</Alert>
              )}
              {dryRun && dryRun.stores.length > 0 && (
                <div className={styles.dryRunList}>
                  {dryRun.stores.map((s) => (
                    <div key={s.store_id} className={styles.storeRow}>
                      <div>
                        <div className={styles.storeName}>{s.name}</div>
                        <div className={styles.storeMeta}>
                          {s.slug} · {tn("saBill.rows", s.row_count, fmtNumber)}
                          {" "}({Object.entries(s.row_counts)
                            .filter(([, n]) => n > 0)
                            .map(([k, n]) => `${k}: ${n}`)
                            .join(", ")})
                        </div>
                      </div>
                      <div className={styles.badge}>
                        <Button
                          size="sm"
                          tone="secondary"
                          onClick={() => setClearTarget({
                            storeId: s.store_id, name: s.name,
                          })}
                        >
                          {t("saBill.pause")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {dryRun && dryRun.stores.length === 0 && (
                <EmptyState title={t("saBill.nothing")} />
              )}
            </Card>
          </Section>
        </>
      )}

      <ConfirmDialog
        open={clearTarget != null}
        title={t("saBill.pauseTitle")}
        message={clearTarget ? t("saBill.pauseBody", { name: clearTarget.name }) : ""}
        confirmLabel={t("saBill.pause")}
        confirmTone="primary"
        busy={clearBusy}
        onConfirm={() => { void doClearRetention(); }}
        onCancel={() => setClearTarget(null)}
      />
    </PageShell>
  );
}
