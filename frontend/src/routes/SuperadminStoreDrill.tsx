import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, apiErrorMessage } from "../lib/api";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  compStore, creditStore, emailStore, endComp, extendTrial, freezeStore,
  linkOwnerToStore, toggleStoreActive, unfreezeStore, unlinkOwnerFromStore,
  useStoreAuditLog, useStoreFeatures, useStoreOwnerLinks,
  type ImpersonationMode, type StoreFeatureRow,
} from "../api/superadmin";
import { billingCycleLabel, planLabel, planTone } from "../api/billing";
import { statusLabel } from "../lib/transferKinds";
import { RolePill } from "../components/RolePill";
import { clearStoreOverride, setStoreOverride } from "../api/featureFlags";
import { getCurrentIdentity } from "../lib/auth";
import { startImpersonation } from "../lib/impersonation";
import {
  Alert, Button, ButtonLink, Card, ConfirmDialog, EmptyState, ErrorState,
  Field, Input, KpiCard, KpiGrid, Loading, Modal, MoneyInput,
  PageHeader, PageShell, Pill, Section, Select,
  Switch, Table, tdStyle, Textarea, thStyle, useToast,
  ModalActions,
} from "../components/ui";
import { AuditTable } from "../components/AuditTable";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { AUDIT_ACTION_OPTIONS, AUDIT_TARGET_OPTIONS } from "../components/auditFilters";
import { t as translate, tn, tNodes, useT, type MessageKey } from "../i18n";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { formatDate } from "../lib/datetime";
import styles from "./SuperadminStoreDrill.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { RolePermissionsEditor } from "../components/RolePermissionsEditor";
import type { components } from "../api/openapi";

type DrillData = components["schemas"]["SuperadminStoreDrillResponse"];

// get_trial_status() values. One the SPA doesn't list shows as sent.
const TRIAL_STATUS_KEYS: Record<string, MessageKey> = {
  exempt: "saDrill.trial.exempt",
  active: "saDrill.trial.active",
  expiring_soon: "saDrill.trial.expiring_soon",
  grace: "saDrill.trial.grace",
  expired: "saDrill.trial.expired",
};
function trialStatusLabel(status: string): string {
  return Object.hasOwn(TRIAL_STATUS_KEYS, status)
    ? translate(TRIAL_STATUS_KEYS[status]) : status;
}

// A transfer's status pill colour. The stored values are "Sent" /
// "Cancelled" (lib/transferKinds STATUSES); the older "Completed" /
// "Canceled" spellings are kept so old rows colour the same.
function transferTone(status: string): "success" | "negative" | "neutral" {
  if (status === "Sent" || status === "Completed") return "success";
  if (status === "Cancelled" || status === "Canceled") return "negative";
  return "neutral";
}

function useStoreDrill(storeId: number | undefined) {
  const identity = getCurrentIdentity();
  return useQuery<DrillData>({
    enabled: identity?.role === "superadmin" && storeId != null,
    queryKey: ["superadmin", "store-drill", storeId],
    queryFn: () => api<DrillData>(`/api/v2/superadmin/stores/${storeId}/drill`),
  });
}


export default function SuperadminStoreDrill() {
  const params = useParams<{ id: string }>();
  const storeId = params.id ? Number(params.id) : undefined;
  const { data, isLoading, isError, error, refetch } = useStoreDrill(storeId);
  const t = useT();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [showEmail, setShowEmail] = useState(false);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [showCredit, setShowCredit] = useState(false);
  const [creditAmount, setCreditAmount] = useState(0);
  const [creditReason, setCreditReason] = useState("");
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditError, setCreditError] = useState<string | null>(null);
  const [showFreeze, setShowFreeze] = useState(false);
  const [freezeReason, setFreezeReason] = useState("");
  const [freezeBusy, setFreezeBusy] = useState(false);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  const [trialDays, setTrialDays] = useState("14");
  const [showComp, setShowComp] = useState(false);
  const [compPlan, setCompPlan] = useState<"basic" | "pro">("pro");
  const [compReason, setCompReason] = useState("");
  const [compBusy, setCompBusy] = useState(false);
  const [compError, setCompError] = useState<string | null>(null);

  // End comp and Disable store change what the store's people can
  // do (billing resumes / everyone is locked out), so both ask first.
  // A refusal shows inside the dialog.
  const [pending, setPending] = useState<"end-comp" | "disable" | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);

  function ask(which: "end-comp" | "disable") {
    setPendingError(null);
    setPending(which);
  }

  async function runPending(id: number) {
    if (pending == null) return;
    setActionBusy(true);
    setPendingError(null);
    try {
      if (pending === "end-comp") {
        const res = await endComp(id);
        toast({
          message: res.stripe_resumed
            ? t("saDrill.compEndedResumed", { plan: planLabel(res.plan) })
            : t("saDrill.compEnded", { plan: planLabel(res.plan) }),
          tone: "success",
        });
      } else {
        await toggleActiveNow(id);
      }
      setPending(null);
      void refetch();
    } catch (e) {
      setPendingError(apiErrorMessage(
        e, pending === "end-comp"
          ? t("saDrill.endCompFailed") : t("saDrill.disableFailed"),
      ));
    } finally { setActionBusy(false); }
  }

  async function toggleActiveNow(id: number) {
    const res = await toggleStoreActive(id);
    toast({
      message: res.is_active ? t("saDrill.enabled") : t("saDrill.disabled"),
      tone: "success",
    });
  }

  async function doExtendTrial(id: number) {
    setActionBusy(true);
    try {
      const res = await extendTrial(id, { days: Number(trialDays) });
      toast({
        message: t("saDrill.trialEnds", {
          date: formatDate(res.trial_ends_at),
          status: trialStatusLabel(res.trial_status),
        }),
        tone: "success",
      });
      void refetch();
    } catch (e) {
      toastApiError(e, t("saDrill.extendFailed"));
    } finally { setActionBusy(false); }
  }

  async function doImpersonate(userId: number, mode: ImpersonationMode) {
    setActionBusy(true);
    try {
      await startImpersonation(userId, mode);
    } catch (e) {
      toastApiError(e, t("saDrill.impersonateFailed"));
      setActionBusy(false);
    }
  }

  async function doUnfreeze(id: number) {
    setActionBusy(true);
    try {
      await unfreezeStore(id);
      toast({ message: t("saDrill.unfrozen"), tone: "success" });
      void refetch();
    } catch (e) {
      toastApiError(e, t("saDrill.unfreezeFailed"));
    } finally { setActionBusy(false); }
  }

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs current={data?.store.name || t("saDrill.storeN", { id: String(storeId) })} />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={apiErrorMessage(error, t("saDrill.loadFailed"))}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <>
          <PageHeader
            title={data.store.name}
            subtitle={data.store.slug}
            actions={(
              <div className={styles.actions}>
                <Button
                  tone="secondary" size="sm"
                  onClick={() => setShowEmail(true)}
                >
                  {t("saDrill.emailAdmin")}
                </Button>
                <Button
                  tone="secondary" size="sm"
                  onClick={() => { setShowCredit(true); setCreditError(null); }}
                >
                  {t("saDrill.credit")}
                </Button>
                {data.store.frozen ? (
                  <Button
                    tone="secondary" size="sm" busy={actionBusy}
                    onClick={() => { void doUnfreeze(data.store.id); }}
                  >
                    {t("saDrill.unfreeze")}
                  </Button>
                ) : (
                  <Button
                    tone="danger" size="sm"
                    onClick={() => { setShowFreeze(true); setFreezeError(null); }}
                  >
                    {t("saDrill.freeze")}
                  </Button>
                )}
                {data.store.comped ? (
                  <Button
                    tone="secondary" size="sm"
                    busy={actionBusy} disabled={actionBusy}
                    onClick={() => ask("end-comp")}
                  >
                    {t("saDrill.endComp")}
                  </Button>
                ) : (
                  <Button
                    tone="secondary" size="sm"
                    onClick={() => { setShowComp(true); setCompError(null); }}
                  >
                    {t("saDrill.compPlan")}
                  </Button>
                )}
                {data.store.plan !== "basic" && data.store.plan !== "pro" && (
                  <span className={styles.trialControl}>
                    <Select
                      aria-label={t("saDrill.trialExtension")}
                      value={trialDays}
                      onChange={(e) => setTrialDays(e.target.value)}
                      disabled={actionBusy}
                    >
                      {[7, 14, 30, 60, 90].map((d) => (
                        <option key={d} value={String(d)}>{t("saDrill.plusDays", { days: String(d) })}</option>
                      ))}
                    </Select>
                    <Button
                      tone="secondary" size="sm"
                      busy={actionBusy} disabled={actionBusy}
                      onClick={() => { void doExtendTrial(data.store.id); }}
                    >
                      {t("saDrill.extendTrial")}
                    </Button>
                  </span>
                )}
                <Button
                  tone="secondary" size="sm"
                  busy={actionBusy}
                  onClick={async () => {
                    // Disabling locks every user out: confirm first.
                    // Enabling gives access back and runs at once.
                    if (data.store.is_active) { ask("disable"); return; }
                    setActionBusy(true);
                    try {
                      await toggleActiveNow(data.store.id);
                      void refetch();
                    } catch (e) {
                      toastApiError(e, t("saDrill.enableFailed"));
                    } finally { setActionBusy(false); }
                  }}
                >
                  {data.store.is_active ? t("saDrill.disable") : t("saDrill.enable")}
                </Button>
                <ButtonLink
                  to={`/superadmin/stores/${data.store.id}/edit`}
                  tone="secondary" size="sm"
                >
                  {t("common.edit")}
                </ButtonLink>
              </div>
            )}
          />

          {data.store.frozen && (
            <Alert tone="warning">
              {tNodes("saDrill.frozenAlert", { frozen: <strong>{t("saDrill.frozenWord")}</strong> })}
              {data.store.frozen_reason ? t("saDrill.reason", { reason: data.store.frozen_reason }) : ""}
              {data.store.frozen_at ? t("saDrill.since", { date: formatDate(data.store.frozen_at) }) : ""}
            </Alert>
          )}

          {data.store.comped && (
            <Alert tone="info">
              {tNodes("saDrill.compedAlert", {
                comped: <strong>{t("saDrill.compedWord")}</strong>,
                plan: planLabel(data.store.plan),
              })}
              {data.store.comped_at ? t("saDrill.compedSince", { date: formatDate(data.store.comped_at) }) : ""}
              {data.store.stripe_customer_id ? t("saDrill.stripePaused") : ""}
              {data.store.comp_reason ? t("saDrill.reason", { reason: data.store.comp_reason }) : ""}
            </Alert>
          )}

          <KpiGrid>
            <KpiCard label={t("saStores.colPlan")} value={
              <Pill tone={planTone(data.store.plan)}>
                {data.store.comped
                  ? t("saDrill.planComp", { plan: planLabel(data.store.plan) })
                  : planLabel(data.store.plan)}
              </Pill>
            } />
            <KpiCard label={t("common.status")} value={data.store.is_active ? t("common.active") : t("common.inactive")} tone={data.store.is_active ? "positive" : "muted"} />
            <KpiCard label={t("saDrill.transfers30")} value={fmtNumber(data.stats_30d.transfer_count)} />
            <KpiCard label={t("saDrill.volume30")} value={fmtMoney2(data.stats_30d.volume)} tone="positive" />
            <KpiCard label={t("saDrill.fees30")} value={fmtMoney2(data.stats_30d.fees)} />
            <KpiCard label={t("saDrill.team")} value={data.team.length} />
          </KpiGrid>

          <div className={styles.grid}>
            <Section title={t("saDrill.storeInfo")}>
              <Card>
                <InfoRow label={t("common.email")} value={data.store.email || "—"} />
                <InfoRow label={t("common.phone")} value={data.store.phone || "—"} />
                <InfoRow label={t("saDrill.address")} value={data.store.address || "—"} />
                <InfoRow label={t("saDrill.billingCycle")} value={data.store.billing_cycle ? billingCycleLabel(data.store.billing_cycle) : "—"} />
                <InfoRow label={t("saDrill.trialStatus")} value={trialStatusLabel(data.store.trial_status)} />
                <InfoRow label={t("saDrill.created")} value={formatDate(data.store.created_at)} />
                {data.store.trial_ends_at && (
                  <InfoRow label={t("saDrill.trialEndsLabel")} value={formatDate(data.store.trial_ends_at)} />
                )}
                {data.store.canceled_at && (
                  <InfoRow label={t("saDrill.cancelled")} value={formatDate(data.store.canceled_at)} />
                )}
                {data.store.stripe_customer_id && (
                  <InfoRow label={t("saDrill.stripeCustomer")} value={data.store.stripe_customer_id} />
                )}
              </Card>
            </Section>

            <Section title={t("saDrill.teamN", { count: String(data.team.length) })}>
              <Card>
                {data.team.length === 0 ? (
                  <EmptyState title={t("saDrill.noTeam")} />
                ) : (
                  data.team.map((u) => (
                    <div key={u.id} className={styles.teamRow}>
                      <div>
                        <div className={styles.teamName}>{u.full_name || u.username}</div>
                        <div className={styles.teamMeta}>
                          {u.username} · {u.email || t("saDrill.noEmail")}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                        <RolePill role={u.role} />
                        {!u.is_active && <Pill tone="neutral">{t("common.inactive")}</Pill>}
                        {u.is_active && (
                          <>
                            <Button
                              size="sm" tone="secondary"
                              busy={actionBusy} disabled={actionBusy}
                              onClick={() => { void doImpersonate(u.id, "read_only"); }}
                            >
                              {t("saDrill.viewAs")}
                            </Button>
                            <Button
                              size="sm" tone="secondary"
                              busy={actionBusy} disabled={actionBusy}
                              onClick={() => { void doImpersonate(u.id, "full"); }}
                            >
                              {t("saDrill.signInAs")}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </Card>
            </Section>
          </div>

          <StoreFeaturesSection storeId={storeId} />

          <OwnerLinksSection storeId={storeId} />

          {data.roster.length > 0 && (
            <Section title={t("saDrill.rosterN", { count: String(data.roster.length) })}>
              <Card>
                <KpiGrid minWidth="120px">
                  {data.roster.map((e) => (
                    <KpiCard
                      key={e.id}
                      label={e.is_active ? t("common.active") : t("common.inactive")}
                      value={e.name}
                      tone={e.is_active ? "neutral" : "muted"}
                    />
                  ))}
                </KpiGrid>
              </Card>
            </Section>
          )}

          <Section title={t("saDrill.recentN", { count: String(data.recent_transfers.length) })}>
            <Card>
              {data.recent_transfers.length === 0 ? (
                <EmptyState title={t("saDrill.noTransfers")} />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th style={thStyle}>{t("saDrill.colDate")}</th>
                      <th style={thStyle}>{t("saDrill.colSender")}</th>
                      <th style={thStyle}>{t("saDrill.colRecipient")}</th>
                      <th style={thStyle}>{t("saDrill.colCompany")}</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>{t("saDrill.colAmount")}</th>
                      <th style={thStyle}>{t("common.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_transfers.map((tr) => (
                      <tr key={tr.id}>
                        <td style={tdStyle}>
                          <span className={styles.monoMuted}>{tr.send_date}</span>
                        </td>
                        <td style={tdStyle}>{tr.sender_name || "—"}</td>
                        <td style={tdStyle}>{tr.recipient_name || "—"}</td>
                        <td style={tdStyle}>{tr.company || "—"}</td>
                        <td style={{ ...tdStyle, textAlign: "right" }}>
                          <span className={styles.mono}>{fmtMoney2(tr.send_amount)}</span>
                        </td>
                        <td style={tdStyle}>
                          <Pill tone={transferTone(tr.status)}>
                            {statusLabel(tr.status)}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </Section>

          <StoreActivitySection storeId={data.store.id} />

          <Section title={t("saDrill.permissions")}>
            <StorePermissionsPanel storeId={data.store.id} />
          </Section>
        </>
      )}

      <Modal
        open={showComp}
        title={t("saDrill.compTitle", { name: data?.store.name ?? t("saDrill.storeFallback") })}
        onClose={() => { setShowComp(false); setCompError(null); }}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!storeId) return;
            setCompBusy(true);
            setCompError(null);
            try {
              const res = await compStore(storeId, { plan: compPlan, reason: compReason.trim() });
              toast({
                message: res.stripe_paused
                  ? t("saDrill.compedStripe", { plan: planLabel(res.plan) })
                  : t("saDrill.comped", { plan: planLabel(res.plan) }),
                tone: "success",
              });
              setShowComp(false);
              setCompReason("");
              void refetch();
            } catch (err) {
              setCompError(apiErrorMessage(err, t("saDrill.compFailed")));
            } finally {
              setCompBusy(false);
            }
          }}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <p style={{ fontSize: "0.85rem", color: "var(--db-text-muted)", margin: 0 }}>
            {t("saDrill.compLead")}
          </p>
          <Field label={t("saStores.colPlan")}>
            <Select
              value={compPlan}
              onChange={(e) => setCompPlan(e.target.value === "basic" ? "basic" : "pro")}
            >
              <option value="pro">{planLabel("pro")}</option>
              <option value="basic">{planLabel("basic")}</option>
            </Select>
          </Field>
          <Field label={t("saDrill.reasonOptional")}>
            <Input
              type="text" value={compReason}
              onChange={(e) => setCompReason(e.target.value)}
              placeholder={t("saDrill.compPlaceholder")}
              maxLength={200}
            />
          </Field>
          {compError && <Alert tone="error">{compError}</Alert>}
          <ModalActions>
            <Button
              tone="secondary" type="button"
              onClick={() => { setShowComp(false); setCompError(null); }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" busy={compBusy} disabled={compBusy}>
              {compBusy ? t("saDrill.applying") : t("saDrill.compThis")}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <Modal
        open={showEmail}
        title={t("saDrill.emailTitle", { name: data?.store.name ?? t("saDrill.storeFallback") })}
        onClose={() => { setShowEmail(false); setEmailError(null); }}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!storeId || !emailSubject.trim() || !emailBody.trim()) return;
            setEmailBusy(true);
            setEmailError(null);
            try {
              const res = await emailStore(storeId, emailSubject.trim(), emailBody.trim());
              toast({ message: tn("saDrill.sent", res.total, fmtNumber), tone: "success" });
              setShowEmail(false);
              setEmailSubject("");
              setEmailBody("");
            } catch (err) {
              setEmailError(apiErrorMessage(err, t("saDrill.sendFailed")));
            } finally {
              setEmailBusy(false);
            }
          }}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <Field label={t("saDrill.subject")}>
            <Input
              type="text" value={emailSubject}
              onChange={(e) => setEmailSubject(e.target.value)}
              placeholder={t("saDrill.subjectPh")}
              maxLength={200} required
            />
          </Field>
          <Field label={t("saDrill.message")}>
            <Textarea
              value={emailBody}
              onChange={(e) => setEmailBody(e.target.value)}
              placeholder={t("saDrill.messagePh")}
              rows={5} maxLength={5000} required
            />
          </Field>
          {emailError && <Alert tone="error">{emailError}</Alert>}
          <ModalActions>
            <Button
              tone="secondary"
              onClick={() => { setShowEmail(false); setEmailError(null); }}
              type="button"
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" busy={emailBusy} disabled={emailBusy}>
              {emailBusy ? t("saDrill.sending") : t("saDrill.sendEmail")}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <Modal
        open={showFreeze}
        title={t("saDrill.freezeTitle", { name: data?.store.name ?? t("saDrill.storeFallback") })}
        onClose={() => { setShowFreeze(false); setFreezeError(null); }}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!storeId) return;
            setFreezeBusy(true);
            setFreezeError(null);
            try {
              await freezeStore(storeId, freezeReason.trim());
              toast({ message: t("saDrill.frozen"), tone: "success" });
              setShowFreeze(false);
              setFreezeReason("");
              void refetch();
            } catch (err) {
              setFreezeError(apiErrorMessage(err, t("saDrill.freezeFailed")));
            } finally {
              setFreezeBusy(false);
            }
          }}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <p style={{ fontSize: "0.85rem", color: "var(--db-text-muted)", margin: 0 }}>
            {t("saDrill.freezeLead")}
          </p>
          <Field label={t("saDrill.reasonOptional")}>
            <Input
              type="text" value={freezeReason}
              onChange={(e) => setFreezeReason(e.target.value)}
              placeholder={t("saDrill.freezePh")}
              maxLength={200}
            />
          </Field>
          {freezeError && <Alert tone="error">{freezeError}</Alert>}
          <ModalActions>
            <Button
              tone="secondary" type="button"
              onClick={() => { setShowFreeze(false); setFreezeError(null); }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" tone="danger" busy={freezeBusy} disabled={freezeBusy}>
              {freezeBusy ? t("saDrill.freezing") : t("saDrill.freezeStore")}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <Modal
        open={showCredit}
        title={t("saDrill.creditTitle", { name: data?.store.name ?? t("saDrill.storeFallback") })}
        onClose={() => { setShowCredit(false); setCreditError(null); }}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!storeId) return;
            // Dollars → cents. Round to the nearest cent so a
            // "12.5" input becomes 1250, not 1249.9999.
            const cents = Math.round(creditAmount * 100);
            if (!Number.isFinite(cents) || cents <= 0) {
              setCreditError(t("saDrill.creditMin"));
              return;
            }
            // The cap the old number input enforced with max="5000".
            if (cents > 500_000) {
              setCreditError(t("saDrill.creditCap"));
              return;
            }
            setCreditBusy(true);
            setCreditError(null);
            try {
              const res = await creditStore(storeId, cents, creditReason.trim());
              toast({
                message: t("saDrill.credited", {
                  amount: fmtMoney2(res.amount_cents / 100),
                  name: data?.store.name ?? t("saDrill.storeFallback"),
                }),
                tone: "success",
              });
              setShowCredit(false);
              setCreditAmount(0);
              setCreditReason("");
            } catch (err) {
              setCreditError(apiErrorMessage(err, t("saDrill.creditFailed")));
            } finally {
              setCreditBusy(false);
            }
          }}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <p style={{ fontSize: "0.85rem", color: "var(--db-text-muted)", margin: 0 }}>
            {t("saDrill.creditLead")}
          </p>
          <MoneyInput
            label={t("saDrill.amountUsd")}
            value={creditAmount}
            onChange={setCreditAmount}
            placeholder="50.00"
            required
            fullWidth
          />
          <Field label={t("saDrill.reasonOptional")}>
            <Input
              type="text" value={creditReason}
              onChange={(e) => setCreditReason(e.target.value)}
              placeholder={t("saDrill.creditPh")}
              maxLength={200}
            />
          </Field>
          {creditError && <Alert tone="error">{creditError}</Alert>}
          <ModalActions>
            <Button
              tone="secondary" type="button"
              onClick={() => { setShowCredit(false); setCreditError(null); }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" busy={creditBusy} disabled={creditBusy}>
              {creditBusy ? t("saDrill.issuing") : t("saDrill.issueCredit")}
            </Button>
          </ModalActions>
        </form>
      </Modal>
      <ConfirmDialog
        open={pending != null && data != null}
        title={pending === "end-comp"
          ? t("saDrill.endCompTitle") : t("saDrill.disableTitle")}
        message={pending === "end-comp"
          ? t("saDrill.endCompMsg", { name: data?.store.name ?? t("saDrill.theStore") })
          : t("saDrill.disableMsg", { name: data?.store.name ?? t("saDrill.storeFallback") })}
        confirmLabel={pending === "end-comp" ? t("saDrill.endComp") : t("saDrill.disableStore")}
        confirmTone="danger"
        busy={actionBusy}
        error={pendingError}
        onConfirm={() => { if (data) void runPending(data.store.id); }}
        onCancel={() => setPending(null)}
      />
    </PageShell>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.infoRow}>
      <span className={styles.infoLabel}>{label}</span>
      <span className={styles.infoValue}>{value}</span>
    </div>
  );
}

// One store's role grid, from the superadmin side: only the roles
// the platform lets a store change are shown. The shared
// RolePermissionsEditor owns the grid, save, reset and unsaved bar.
function StorePermissionsPanel({ storeId }: { storeId: number }) {
  const t = useT();
  return (
    <RolePermissionsEditor
      endpoint={`/api/v2/superadmin/stores/${storeId}/permissions`}
      queryKey={["superadmin", "store-permissions", storeId]}
      hideLockedRoles
      intro={
        <p className={styles.permIntro}>
          {t("saDrill.permIntro")}
        </p>
      }
    />
  );
}


// ── Owner links (U-5b concierge onboarding) ────────────────
//
// "We create the logins and connect the stores to the owner login
// on the customer's instruction" — list the owners connected to
// this store, connect an existing owner by username, disconnect
// on request. Home-store links are protected server-side.

// Modules, add-ons and platform flags as they apply to THIS store.
// The switch sets a per-store override on the same endpoint the
// Feature-flags page uses; "Reset" clears it so the store follows
// its business-type bundle (modules) or the global default again.
// A module change reaches the store's users on their next shell
// load (session-status carries the live module list).
const FEATURE_KIND_LABEL: Record<StoreFeatureRow["kind"], MessageKey> = {
  module: "saDrill.kindModule", addon: "saDrill.kindAddon", flag: "saDrill.kindFlag",
};

function StoreFeaturesSection({ storeId }: { storeId: number | undefined }) {
  const features = useStoreFeatures(storeId);
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  function refresh() {
    void qc.invalidateQueries({
      queryKey: ["superadmin", "store-features", storeId],
    });
  }

  async function setOverride(row: StoreFeatureRow, enabled: boolean) {
    if (storeId == null) return;
    setBusyKey(row.key);
    try {
      await setStoreOverride(row.key, storeId, enabled);
      refresh();
      toast({
        message: t(enabled ? "saDrill.featOn" : "saDrill.featOff", { label: row.label }),
        tone: "success",
      });
    } catch (e) {
      toastApiError(e, t("saDrill.featFailed"));
    } finally {
      setBusyKey(null);
    }
  }

  async function reset(row: StoreFeatureRow) {
    if (storeId == null) return;
    setBusyKey(row.key);
    try {
      await clearStoreOverride(row.key, storeId);
      refresh();
      toast({ message: t("saDrill.featReset", { label: row.label }), tone: "success" });
    } catch (e) {
      toastApiError(e, t("saDrill.featResetFailed"));
    } finally {
      setBusyKey(null);
    }
  }

  const rows = features.data?.rows ?? [];
  return (
    <Section title={t("saDrill.modules")}>
      <Card>
        {features.isLoading && <Loading />}
        {features.isError && (
          <ErrorState
            message={t("saDrill.modulesFailed")}
            onRetry={() => { void features.refetch(); }}
          />
        )}
        {features.data && rows.length === 0 && (
          <EmptyState title={t("saDrill.noFlags")} />
        )}
        {rows.map((row) => (
          <div key={row.key} className={styles.featureRow}>
            <div className={styles.featureText}>
              <div className={styles.teamName}>
                {row.label}
                <span className={styles.featureKind}>{Object.hasOwn(FEATURE_KIND_LABEL, row.kind) ? t(FEATURE_KIND_LABEL[row.kind]) : row.kind}</span>
              </div>
              {row.description && (
                <div className={styles.teamMeta}>{row.description}</div>
              )}
              <div className={styles.teamMeta}>
                {row.override == null
                  ? t(row.default ? "saDrill.defaultOn" : "saDrill.defaultOff")
                  : t(row.default ? "saDrill.overriddenOn" : "saDrill.overriddenOff")}
                {row.override != null && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className={styles.linkButton}
                      disabled={busyKey === row.key}
                      onClick={() => { void reset(row); }}
                    >
                      {t("saDrill.resetDefault")}
                    </button>
                  </>
                )}
              </div>
            </div>
            <Switch
              checked={row.effective}
              disabled={busyKey === row.key}
              aria-label={t("saDrill.forStore", { label: row.label })}
              onChange={(next) => { void setOverride(row, next); }}
            />
          </div>
        ))}
      </Card>
    </Section>
  );
}


function OwnerLinksSection({ storeId }: { storeId: number | undefined }) {
  const links = useStoreOwnerLinks(storeId);
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    void qc.invalidateQueries({
      queryKey: ["superadmin", "store", storeId, "owner-links"],
    });
  }

  async function add() {
    if (storeId == null || !username.trim()) return;
    setBusy(true); setError(null);
    try {
      await linkOwnerToStore(storeId, username.trim());
      setUsername("");
      refresh();
      toast({ message: t("saDrill.ownerConnected"), tone: "success" });
    } catch (err) {
      setError(apiErrorMessage(err, t("saDrill.connectFailed")));
    } finally {
      setBusy(false);
    }
  }

  // Disconnect asks first; a refusal shows inside the dialog.
  const [disconnecting, setDisconnecting] =
    useState<{ ownerId: number; name: string } | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  async function remove() {
    if (storeId == null || disconnecting == null) return;
    const { ownerId, name } = disconnecting;
    setBusy(true); setDisconnectError(null);
    try {
      await unlinkOwnerFromStore(storeId, ownerId);
      setDisconnecting(null);
      refresh();
      toast({ message: t("saDrill.disconnected", { name }), tone: "success" });
    } catch (err) {
      setDisconnectError(apiErrorMessage(err, t("saDrill.disconnectFailed")));
    } finally {
      setBusy(false);
    }
  }

  const rows = links.data?.rows ?? [];
  return (
    <Section title={t("saDrill.ownersN", { count: String(rows.length) })}>
      <Card>
        {error && <Alert tone="error">{error}</Alert>}
        {links.isLoading && <Loading />}
        {rows.length === 0 && !links.isLoading && (
          <EmptyState
            title={t("saDrill.noOwner")}
            body={t("saDrill.noOwnerBody")}
          />
        )}
        {rows.map((r) => (
          <div key={r.owner_id} className={styles.teamRow}>
            <div>
              <div className={styles.teamName}>{r.full_name || r.username}</div>
              <div className={styles.teamMeta}>
                {r.username}
                {r.linked_at ? t("saDrill.linked", { date: formatDate(r.linked_at) }) : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
              {!r.is_active && <Pill tone="neutral">{t("common.inactive")}</Pill>}
              <Button
                size="sm" tone="danger" disabled={busy}
                onClick={() => {
                  setDisconnectError(null);
                  setDisconnecting({ ownerId: r.owner_id, name: r.username });
                }}
              >
                {t("saDrill.disconnect")}
              </Button>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <Field label={t("saDrill.connectLabel")}>
              <Input
                placeholder="owner@example.com"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={busy}
              />
            </Field>
          </div>
          <Button
            tone="primary" disabled={busy || !username.trim()}
            onClick={() => { void add(); }}
          >
            {t("saDrill.connect")}
          </Button>
        </div>
      </Card>
      <ConfirmDialog
        open={disconnecting != null}
        title={t("saDrill.disconnectTitle", { name: disconnecting?.name ?? "" })}
        message={t("saDrill.disconnectMsg")}
        confirmLabel={t("saDrill.disconnect")}
        confirmTone="danger"
        busy={busy}
        error={disconnectError}
        onConfirm={() => { void remove(); }}
        onCancel={() => setDisconnecting(null)}
      />
    </Section>
  );
}


// ── Activity ──────────────────────────────────────────────────
//
// The store's own audit feed (what its admin sees on
// /app/admin/audit-log), read here so a support question about
// "who changed this" is answered from the store page. Rows written
// during an impersonation carry "(via superadmin …)" in the actor.
function StoreActivitySection({ storeId }: { storeId: number }) {
  const t = useT();
  // Filters and page in the URL, like every list: refresh and Back
  // keep the superadmin where they were.
  const filters = useUrlFilterState(
    { activity_target: "", activity_action: "" },
    { pageSizeKey: "store-activity" },
  );
  const target = filters.params.activity_target;
  const action = filters.params.activity_action;
  const log = useStoreAuditLog(storeId, {
    page: filters.page, target, action, perPage: filters.perPage,
  });

  return (
    <Section title={t("saDrill.activity")}>
      <Card>
        <div className={styles.activityFilters}>
          <Field label={t("saDrill.target")} style={{ minWidth: "10rem" }}>
            <Select
              aria-label={t("saDrill.activityTarget")}
              value={target}
              onChange={(e) => filters.setParam("activity_target", e.target.value)}
            >
              {AUDIT_TARGET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{t(o.label)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("saDrill.action")} style={{ minWidth: "10rem" }}>
            <Select
              aria-label={t("saDrill.activityAction")}
              value={action}
              onChange={(e) => filters.setParam("activity_action", e.target.value)}
            >
              {AUDIT_ACTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{t(o.label)}</option>
              ))}
            </Select>
          </Field>
          <span className={styles.activityCount}>
            {log.data ? tn("saEmail.events", log.data.total, fmtNumber) : ""}
          </span>
        </div>
        <AuditTable
          rows={log.data?.rows}
          isLoading={log.isLoading} isError={log.isError} error={log.error}
          onRetry={() => { void log.refetch(); }}
          errorMessage={t("saDrill.activityFailed")}
          emptyTitle={t("saDrill.noActivity")}
          page={log.data && {
            page: log.data.page, totalPages: log.data.total_pages, total: log.data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
        />
      </Card>
    </Section>
  );
}
