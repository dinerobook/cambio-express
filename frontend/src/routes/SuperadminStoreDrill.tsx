import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../lib/api";
import { toggleMatrixCell } from "../lib/permissions";
import { fmtMoney2 } from "../lib/formatters";
import {
  compStore, creditStore, emailStore, endComp, extendTrial, freezeStore,
  linkOwnerToStore, toggleStoreActive, unfreezeStore, unlinkOwnerFromStore,
  useStoreAuditLog, useStoreFeatures, useStoreOwnerLinks,
  type ImpersonationMode, type StoreFeatureRow,
} from "../api/superadmin";
import { useProfile } from "../api/account";
import { clearStoreOverride, setStoreOverride } from "../api/featureFlags";
import { getCurrentIdentity } from "../lib/auth";
import { startImpersonation } from "../lib/impersonation";
import {
  Alert, Breadcrumbs, Button, ButtonLink, Card, EmptyState,
  ErrorState, Field, Input, KpiCard, KpiGrid, Loading, Modal,
  PageHeader, PageShell, Pager, Pill, Section, SectionTitle, Select,
  Switch, Table, TableStates, tdStyle, Textarea, thStyle, useToast,
} from "../components/ui";
import { PermissionMatrixTable } from "../components/PermissionMatrixTable";
import { AuditTable } from "../components/AuditTable";
import { AUDIT_ACTION_OPTIONS, AUDIT_TARGET_OPTIONS } from "../components/auditFilters";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { formatDate } from "../lib/datetime";
import styles from "./SuperadminStoreDrill.module.css";

interface StoreInfo {
  id: number; name: string; slug: string; email: string;
  phone: string; address: string; plan: string;
  billing_cycle: string; is_active: boolean;
  trial_status: string; created_at: string;
  trial_ends_at: string; canceled_at: string;
  stripe_customer_id: string;
  frozen: boolean; frozen_at: string; frozen_reason: string;
  /** On a free Basic/Pro plan handed out by a superadmin; Stripe
   *  collection is paused while this is set. */
  comped: boolean; comped_at: string; comp_reason: string;
}

interface TeamMember {
  id: number; username: string; full_name: string;
  role: string; email: string; is_active: boolean;
  has_2fa: boolean; last_login_at: string;
}

interface TransferRow {
  id: number; send_date: string; sender_name: string;
  recipient_name: string; company: string;
  send_amount: number; fee: number; total_collected: number;
  status: string; created_at: string;
}

interface DrillData {
  store: StoreInfo;
  team: TeamMember[];
  roster: Array<{ id: number; name: string; is_active: boolean }>;
  recent_transfers: TransferRow[];
  stats_30d: { transfer_count: number; volume: number; fees: number };
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
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [showEmail, setShowEmail] = useState(false);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [showCredit, setShowCredit] = useState(false);
  const [creditAmount, setCreditAmount] = useState("");
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

  async function doEndComp(id: number) {
    setActionBusy(true);
    try {
      const res = await endComp(id);
      toast({
        message: res.stripe_resumed
          ? `Comp ended — billing resumed on the ${res.plan} plan.`
          : `Comp ended — the store is on ${res.plan} now.`,
        tone: "success",
      });
      void refetch();
    } catch (e) {
      toastApiError(e, "Could not end the comp");
    } finally { setActionBusy(false); }
  }

  async function doExtendTrial(id: number) {
    setActionBusy(true);
    try {
      const res = await extendTrial(id, { days: Number(trialDays) });
      toast({
        message: `Trial now ends ${formatDate(res.trial_ends_at)} (${res.trial_status.replace("_", " ")}).`,
        tone: "success",
      });
      void refetch();
    } catch (e) {
      toastApiError(e, "Could not extend the trial");
    } finally { setActionBusy(false); }
  }

  async function doImpersonate(userId: number, mode: ImpersonationMode) {
    setActionBusy(true);
    try {
      await startImpersonation(userId, mode);
    } catch (e) {
      toastApiError(e, "Could not sign in as this user");
      setActionBusy(false);
    }
  }

  async function doUnfreeze(id: number) {
    setActionBusy(true);
    try {
      await unfreezeStore(id);
      toast({ message: "Store unfrozen.", tone: "success" });
      void refetch();
    } catch (e) {
      toastApiError(e, "Failed to unfreeze");
    } finally { setActionBusy(false); }
  }

  return (
    <PageShell gap="1.25rem">
      <Breadcrumbs crumbs={[
        { label: "Stores", to: "/superadmin/stores" },
        { label: data?.store.name || `Store #${storeId}` },
      ]} />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={error instanceof Error ? error.message : "Could not load store"}
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
                  Email admin
                </Button>
                <Button
                  tone="secondary" size="sm"
                  onClick={() => { setShowCredit(true); setCreditError(null); }}
                >
                  Credit account
                </Button>
                {data.store.frozen ? (
                  <Button
                    tone="secondary" size="sm" busy={actionBusy}
                    onClick={() => { void doUnfreeze(data.store.id); }}
                  >
                    Unfreeze
                  </Button>
                ) : (
                  <Button
                    tone="danger" size="sm"
                    onClick={() => { setShowFreeze(true); setFreezeError(null); }}
                  >
                    Freeze
                  </Button>
                )}
                {data.store.comped ? (
                  <Button
                    tone="secondary" size="sm"
                    busy={actionBusy} disabled={actionBusy}
                    onClick={() => { void doEndComp(data.store.id); }}
                  >
                    End comp
                  </Button>
                ) : (
                  <Button
                    tone="secondary" size="sm"
                    onClick={() => { setShowComp(true); setCompError(null); }}
                  >
                    Comp plan
                  </Button>
                )}
                {data.store.plan !== "basic" && data.store.plan !== "pro" && (
                  <span className={styles.trialControl}>
                    <Select
                      aria-label="Trial extension"
                      value={trialDays}
                      onChange={(e) => setTrialDays(e.target.value)}
                      disabled={actionBusy}
                    >
                      {[7, 14, 30, 60, 90].map((d) => (
                        <option key={d} value={String(d)}>+{d} days</option>
                      ))}
                    </Select>
                    <Button
                      tone="secondary" size="sm"
                      busy={actionBusy} disabled={actionBusy}
                      onClick={() => { void doExtendTrial(data.store.id); }}
                    >
                      Extend trial
                    </Button>
                  </span>
                )}
                <Button
                  tone="secondary" size="sm"
                  busy={actionBusy}
                  onClick={async () => {
                    setActionBusy(true);
                    try {
                      const res = await toggleStoreActive(data.store.id);
                      toast({ message: res.is_active ? "Store enabled." : "Store disabled.", tone: "success" });
                      void refetch();
                    } catch (e) {
                      toastApiError(e, "Failed");
                    } finally { setActionBusy(false); }
                  }}
                >
                  {data.store.is_active ? "Disable" : "Enable"}
                </Button>
                <ButtonLink
                  href={`/superadmin/stores/${data.store.id}/edit`}
                  tone="secondary" size="sm"
                >
                  Edit
                </ButtonLink>
              </div>
            )}
          />

          {data.store.frozen && (
            <Alert tone="warning">
              This store is <strong>frozen</strong> — its users are locked out
              to a “suspended” screen until you unfreeze it.
              {data.store.frozen_reason ? ` Reason: ${data.store.frozen_reason}.` : ""}
              {data.store.frozen_at ? ` Since ${formatDate(data.store.frozen_at)}.` : ""}
            </Alert>
          )}

          {data.store.comped && (
            <Alert tone="info">
              This store is <strong>comped</strong> on the {data.store.plan} plan
              {data.store.comped_at ? ` since ${formatDate(data.store.comped_at)}` : ""}
              {data.store.stripe_customer_id ? "; Stripe collection is paused" : ""}.
              {data.store.comp_reason ? ` Reason: ${data.store.comp_reason}.` : ""}
            </Alert>
          )}

          <KpiGrid>
            <KpiCard label="Plan" value={data.store.comped ? `${data.store.plan} (comp)` : data.store.plan} tone={
              data.store.plan === "pro" ? "neon"
              : data.store.plan === "basic" ? "positive"
              : data.store.plan === "trial" ? "warning"
              : "negative"
            } />
            <KpiCard label="Status" value={data.store.is_active ? "Active" : "Inactive"} tone={data.store.is_active ? "positive" : "muted"} />
            <KpiCard label="Transfers (30d)" value={data.stats_30d.transfer_count.toLocaleString()} />
            <KpiCard label="Volume (30d)" value={fmtMoney2(data.stats_30d.volume)} tone="positive" />
            <KpiCard label="Fees (30d)" value={fmtMoney2(data.stats_30d.fees)} />
            <KpiCard label="Team" value={data.team.length} />
          </KpiGrid>

          <div className={styles.grid}>
            <Section title="Store info">
              <Card>
                <InfoRow label="Email" value={data.store.email || "—"} />
                <InfoRow label="Phone" value={data.store.phone || "—"} />
                <InfoRow label="Address" value={data.store.address || "—"} />
                <InfoRow label="Billing cycle" value={data.store.billing_cycle || "—"} />
                <InfoRow label="Trial status" value={data.store.trial_status} />
                <InfoRow label="Created" value={formatDate(data.store.created_at)} />
                {data.store.trial_ends_at && (
                  <InfoRow label="Trial ends" value={formatDate(data.store.trial_ends_at)} />
                )}
                {data.store.canceled_at && (
                  <InfoRow label="Cancelled" value={formatDate(data.store.canceled_at)} />
                )}
                {data.store.stripe_customer_id && (
                  <InfoRow label="Stripe customer" value={data.store.stripe_customer_id} />
                )}
              </Card>
            </Section>

            <Section title={`Team (${data.team.length})`}>
              <Card>
                {data.team.length === 0 ? (
                  <EmptyState title="No team members." />
                ) : (
                  data.team.map((u) => (
                    <div key={u.id} className={styles.teamRow}>
                      <div>
                        <div className={styles.teamName}>{u.full_name || u.username}</div>
                        <div className={styles.teamMeta}>
                          {u.username} · {u.email || "no email"}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                        <Pill tone={
                          u.role === "admin" ? "accent"
                          : u.role === "owner" ? "info"
                          : "neutral"
                        }>{u.role}</Pill>
                        {!u.is_active && <Pill tone="neutral">Inactive</Pill>}
                        {u.is_active && (
                          <>
                            <Button
                              size="sm" tone="secondary"
                              busy={actionBusy} disabled={actionBusy}
                              onClick={() => { void doImpersonate(u.id, "read_only"); }}
                            >
                              View as
                            </Button>
                            <Button
                              size="sm" tone="secondary"
                              busy={actionBusy} disabled={actionBusy}
                              onClick={() => { void doImpersonate(u.id, "full"); }}
                            >
                              Sign in as
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
            <Section title={`Employee roster (${data.roster.length})`}>
              <Card>
                <KpiGrid minWidth="120px">
                  {data.roster.map((e) => (
                    <KpiCard
                      key={e.id}
                      label={e.is_active ? "Active" : "Inactive"}
                      value={e.name}
                      tone={e.is_active ? "neutral" : "muted"}
                    />
                  ))}
                </KpiGrid>
              </Card>
            </Section>
          )}

          <Section title={`Recent transfers (${data.recent_transfers.length})`}>
            <Card>
              {data.recent_transfers.length === 0 ? (
                <EmptyState title="No transfers yet." />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th style={thStyle}>Date</th>
                      <th style={thStyle}>Sender</th>
                      <th style={thStyle}>Recipient</th>
                      <th style={thStyle}>Company</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
                      <th style={thStyle}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_transfers.map((t) => (
                      <tr key={t.id}>
                        <td style={tdStyle}>
                          <span className={styles.monoMuted}>{t.send_date}</span>
                        </td>
                        <td style={tdStyle}>{t.sender_name || "—"}</td>
                        <td style={tdStyle}>{t.recipient_name || "—"}</td>
                        <td style={tdStyle}>{t.company || "—"}</td>
                        <td style={{ ...tdStyle, textAlign: "right" }}>
                          <span className={styles.mono}>{fmtMoney2(t.send_amount)}</span>
                        </td>
                        <td style={tdStyle}>
                          <Pill tone={t.status === "Completed" ? "success" : t.status === "Canceled" ? "negative" : "neutral"}>
                            {t.status}
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

          <Section title="Permissions">
            <StorePermissionsPanel storeId={data.store.id} storeName={data.store.name} />
          </Section>
        </>
      )}

      <Modal
        open={showComp}
        title={`Comp ${data?.store.name ?? "store"}`}
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
                  ? `Comped on ${res.plan} — Stripe billing paused.`
                  : `Comped on ${res.plan}.`,
                tone: "success",
              });
              setShowComp(false);
              setCompReason("");
              void refetch();
            } catch (err) {
              setCompError(err instanceof ApiError ? err.message : "Could not comp this store.");
            } finally {
              setCompBusy(false);
            }
          }}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <p style={{ fontSize: "0.85rem", color: "var(--db-text-muted)", margin: 0 }}>
            Gives the store a paid plan for free. If it pays through
            Stripe, the subscription stays but collection is paused —
            nothing is invoiced until you end the comp. A cancellation
            from Stripe while comped does not take the plan away.
          </p>
          <Field label="Plan">
            <Select
              value={compPlan}
              onChange={(e) => setCompPlan(e.target.value === "basic" ? "basic" : "pro")}
            >
              <option value="pro">Pro</option>
              <option value="basic">Basic</option>
            </Select>
          </Field>
          <Field label="Reason (optional)">
            <Input
              type="text" value={compReason}
              onChange={(e) => setCompReason(e.target.value)}
              placeholder="Design partner, make-good, friends & family…"
              maxLength={200}
            />
          </Field>
          {compError && <Alert tone="error">{compError}</Alert>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <Button
              tone="secondary" type="button"
              onClick={() => { setShowComp(false); setCompError(null); }}
            >
              Cancel
            </Button>
            <Button type="submit" busy={compBusy} disabled={compBusy}>
              {compBusy ? "Applying…" : "Comp this store"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={showEmail}
        title={`Email ${data?.store.name ?? "store"} admin`}
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
              toast({ message: `Sent to ${res.total} recipient(s).`, tone: "success" });
              setShowEmail(false);
              setEmailSubject("");
              setEmailBody("");
            } catch (err) {
              setEmailError(err instanceof ApiError ? err.message : "Could not send.");
            } finally {
              setEmailBusy(false);
            }
          }}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <Field label="Subject">
            <Input
              type="text" value={emailSubject}
              onChange={(e) => setEmailSubject(e.target.value)}
              placeholder="Subject line…"
              maxLength={200} required
            />
          </Field>
          <Field label="Message">
            <Textarea
              value={emailBody}
              onChange={(e) => setEmailBody(e.target.value)}
              placeholder="Your message to the store admin…"
              rows={5} maxLength={5000} required
            />
          </Field>
          {emailError && <Alert tone="error">{emailError}</Alert>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <Button
              tone="secondary"
              onClick={() => { setShowEmail(false); setEmailError(null); }}
              type="button"
            >
              Cancel
            </Button>
            <Button type="submit" busy={emailBusy} disabled={emailBusy}>
              {emailBusy ? "Sending…" : "Send email"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={showFreeze}
        title={`Freeze ${data?.store.name ?? "store"}`}
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
              toast({ message: "Store frozen.", tone: "success" });
              setShowFreeze(false);
              setFreezeReason("");
              void refetch();
            } catch (err) {
              setFreezeError(err instanceof ApiError ? err.message : "Could not freeze.");
            } finally {
              setFreezeBusy(false);
            }
          }}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <p style={{ fontSize: "0.85rem", color: "var(--db-text-muted)", margin: 0 }}>
            Suspends the store. Its users are locked out to a “suspended,
            contact support” screen — re-subscribing won’t lift it, only
            an unfreeze here does. Their data is untouched.
          </p>
          <Field label="Reason (optional)">
            <Input
              type="text" value={freezeReason}
              onChange={(e) => setFreezeReason(e.target.value)}
              placeholder="Abuse, chargeback dispute, non-payment…"
              maxLength={200}
            />
          </Field>
          {freezeError && <Alert tone="error">{freezeError}</Alert>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <Button
              tone="secondary" type="button"
              onClick={() => { setShowFreeze(false); setFreezeError(null); }}
            >
              Cancel
            </Button>
            <Button type="submit" tone="danger" busy={freezeBusy} disabled={freezeBusy}>
              {freezeBusy ? "Freezing…" : "Freeze store"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={showCredit}
        title={`Credit ${data?.store.name ?? "store"}`}
        onClose={() => { setShowCredit(false); setCreditError(null); }}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!storeId) return;
            // Dollars → cents. Round to the nearest cent so a
            // "12.5" input becomes 1250, not 1249.9999.
            const cents = Math.round(Number(creditAmount) * 100);
            if (!Number.isFinite(cents) || cents <= 0) {
              setCreditError("Enter an amount greater than $0.");
              return;
            }
            setCreditBusy(true);
            setCreditError(null);
            try {
              const res = await creditStore(storeId, cents, creditReason.trim());
              toast({
                message: `Credited ${fmtMoney2(res.amount_cents / 100)} to ${data?.store.name ?? "store"}.`,
                tone: "success",
              });
              setShowCredit(false);
              setCreditAmount("");
              setCreditReason("");
            } catch (err) {
              setCreditError(err instanceof ApiError ? err.message : "Could not issue credit.");
            } finally {
              setCreditBusy(false);
            }
          }}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <p style={{ fontSize: "0.85rem", color: "var(--db-text-muted)", margin: 0 }}>
            Adds a credit to this store's Stripe balance. Stripe applies
            it to their next invoice automatically. The store must be on
            a paid plan (have a Stripe customer).
          </p>
          <Field label="Amount (USD)">
            <Input
              type="number" inputMode="decimal"
              min="0.01" max="5000" step="0.01"
              value={creditAmount}
              onChange={(e) => setCreditAmount(e.target.value)}
              placeholder="50.00"
              required
            />
          </Field>
          <Field label="Reason (optional)">
            <Input
              type="text" value={creditReason}
              onChange={(e) => setCreditReason(e.target.value)}
              placeholder="Downtime make-good, billing dispute…"
              maxLength={200}
            />
          </Field>
          {creditError && <Alert tone="error">{creditError}</Alert>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <Button
              tone="secondary" type="button"
              onClick={() => { setShowCredit(false); setCreditError(null); }}
            >
              Cancel
            </Button>
            <Button type="submit" busy={creditBusy} disabled={creditBusy}>
              {creditBusy ? "Issuing…" : "Issue credit"}
            </Button>
          </div>
        </form>
      </Modal>
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

interface PermMatrix {
  store_id: number;
  store_name: string;
  roles: string[];
  editable_roles: string[];
  resources: string[];
  actions: string[];
  matrix: Record<string, Record<string, Record<string, boolean>>>;
  has_overrides: string[];
}

function StorePermissionsPanel({ storeId, storeName }: { storeId: number; storeName: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const { data, isLoading } = useQuery<PermMatrix>({
    queryKey: ["superadmin", "store-permissions", storeId],
    queryFn: () => api<PermMatrix>(`/api/v2/superadmin/stores/${storeId}/permissions`),
  });
  const [draft, setDraft] = useState<PermMatrix | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setDraft(structuredClone(data)); // eslint-disable-line react-hooks/set-state-in-effect -- hydrate local editable draft from server-fetched permissions
  }, [data]);

  const isDirty = data && draft
    ? JSON.stringify(data.matrix) !== JSON.stringify(draft.matrix)
    : false;

  function toggle(role: string, resource: string, action: string) {
    if (!draft) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      next.matrix[role][resource] = toggleMatrixCell(next.matrix[role][resource], action);
      return next;
    });
  }

  async function save() {
    if (!data || !draft) return;
    setBusy(true);
    const editableMatrix: Record<string, Record<string, Record<string, boolean>>> = {};
    for (const role of draft.editable_roles) {
      editableMatrix[role] = draft.matrix[role];
    }
    try {
      const result = await api<PermMatrix>(`/api/v2/superadmin/stores/${storeId}/permissions`, {
        method: "PUT", json: { matrix: editableMatrix },
      });
      setDraft(structuredClone(result));
      qc.setQueryData(["superadmin", "store-permissions", storeId], result);
      toast({ message: `Permissions updated for ${storeName}.`, tone: "success" });
    } catch (err) {
      toastApiError(err, "Failed to save.");
    } finally { setBusy(false); }
  }

  async function resetRole(role: string) {
    setBusy(true);
    try {
      const result = await api<PermMatrix>(`/api/v2/superadmin/stores/${storeId}/permissions/reset`, {
        method: "POST", json: { role },
      });
      setDraft(structuredClone(result));
      qc.setQueryData(["superadmin", "store-permissions", storeId], result);
      toast({ message: `${role} permissions reset to global defaults.`, tone: "success" });
    } catch (err) {
      toastApiError(err, "Failed to reset.");
    } finally { setBusy(false); }
  }

  if (isLoading || !draft) return <Card><Loading /></Card>;

  return (
    <Card>
      <p style={{ fontSize: "0.85rem", color: "var(--db-text-muted)", margin: "0 0 1rem" }}>
        Per-store permission overrides. Changes take effect immediately (affected users are logged out).
      </p>
      {draft.editable_roles.map((role) => (
        <div key={role} style={{ marginBottom: "1.25rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <SectionTitle>
              <Pill tone={role === "admin" ? "accent" : "neutral"}>{role}</Pill>
              {draft.has_overrides.includes(role) && (
                <span style={{ fontSize: "0.75rem", color: "var(--db-text-muted)", marginLeft: "0.5rem" }}>customized</span>
              )}
            </SectionTitle>
            {draft.has_overrides.includes(role) && (
              <Button size="sm" tone="secondary" onClick={() => { void resetRole(role); }} disabled={busy}>
                Reset to defaults
              </Button>
            )}
          </div>
          <PermissionMatrixTable
            resources={draft.resources}
            actions={draft.actions}
            checked={(resource, action) => draft.matrix[role][resource][action]}
            onToggle={(resource, action) => toggle(role, resource, action)}
            ariaContext={role}
          />
        </div>
      ))}
      {isDirty && (
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="secondary" onClick={() => { if (data) setDraft(structuredClone(data)); }} disabled={busy}>
            Discard
          </Button>
          <Button onClick={() => { void save(); }} busy={busy}>
            Save permissions
          </Button>
        </div>
      )}
    </Card>
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
const FEATURE_KIND_LABEL: Record<StoreFeatureRow["kind"], string> = {
  module: "Module", addon: "Add-on", flag: "Platform flag",
};

function StoreFeaturesSection({ storeId }: { storeId: number | undefined }) {
  const features = useStoreFeatures(storeId);
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
        message: `${row.label}: ${enabled ? "on" : "off"} for this store.`,
        tone: "success",
      });
    } catch (e) {
      toastApiError(e, "Could not change this setting");
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
      toast({ message: `${row.label}: back to the default.`, tone: "success" });
    } catch (e) {
      toastApiError(e, "Could not reset this setting");
    } finally {
      setBusyKey(null);
    }
  }

  const rows = features.data?.rows ?? [];
  return (
    <Section title="Modules & add-ons">
      <Card>
        {features.isLoading && <Loading />}
        {features.isError && (
          <ErrorState
            message="Could not load this store's modules."
            onRetry={() => { void features.refetch(); }}
          />
        )}
        {features.data && rows.length === 0 && (
          <EmptyState title="No flags registered." />
        )}
        {rows.map((row) => (
          <div key={row.key} className={styles.featureRow}>
            <div className={styles.featureText}>
              <div className={styles.teamName}>
                {row.label}
                <span className={styles.featureKind}>{FEATURE_KIND_LABEL[row.kind]}</span>
              </div>
              {row.description && (
                <div className={styles.teamMeta}>{row.description}</div>
              )}
              <div className={styles.teamMeta}>
                {row.override == null
                  ? `Default for this store: ${row.default ? "on" : "off"}`
                  : `Overridden (default ${row.default ? "on" : "off"})`}
                {row.override != null && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className={styles.linkButton}
                      disabled={busyKey === row.key}
                      onClick={() => { void reset(row); }}
                    >
                      Reset to default
                    </button>
                  </>
                )}
              </div>
            </div>
            <Switch
              checked={row.effective}
              disabled={busyKey === row.key}
              aria-label={`${row.label} for this store`}
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
      toast({ message: "Owner connected.", tone: "success" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not connect the owner.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(ownerId: number, name: string) {
    if (storeId == null) return;
    setBusy(true); setError(null);
    try {
      await unlinkOwnerFromStore(storeId, ownerId);
      refresh();
      toast({ message: `${name} disconnected.`, tone: "success" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disconnect the owner.");
    } finally {
      setBusy(false);
    }
  }

  const rows = links.data?.rows ?? [];
  return (
    <Section title={`Owners (${rows.length})`}>
      <Card>
        {error && <Alert tone="error">{error}</Alert>}
        {links.isLoading && <Loading />}
        {rows.length === 0 && !links.isLoading && (
          <EmptyState
            title="No owner connected."
            body="Connect an existing owner login below, or create the store's initial user as an owner."
          />
        )}
        {rows.map((r) => (
          <div key={r.owner_id} className={styles.teamRow}>
            <div>
              <div className={styles.teamName}>{r.full_name || r.username}</div>
              <div className={styles.teamMeta}>
                {r.username}
                {r.linked_at ? ` · linked ${formatDate(r.linked_at)}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
              {!r.is_active && <Pill tone="neutral">Inactive</Pill>}
              <Button
                size="sm" tone="danger" disabled={busy}
                onClick={() => { void remove(r.owner_id, r.username); }}
              >
                Disconnect
              </Button>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <Field label="Connect an owner by username">
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
            Connect
          </Button>
        </div>
      </Card>
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
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState("");
  const [action, setAction] = useState("");
  const { data: profile } = useProfile();
  const log = useStoreAuditLog(storeId, { page, target, action });
  const userTz = profile?.timezone ?? "";

  return (
    <Section title="Activity">
      <Card>
        <div className={styles.activityFilters}>
          <Field label="Target" style={{ minWidth: "10rem" }}>
            <Select
              aria-label="Activity target"
              value={target}
              onChange={(e) => { setTarget(e.target.value); setPage(1); }}
            >
              {AUDIT_TARGET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Action" style={{ minWidth: "10rem" }}>
            <Select
              aria-label="Activity action"
              value={action}
              onChange={(e) => { setAction(e.target.value); setPage(1); }}
            >
              {AUDIT_ACTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <span className={styles.activityCount}>
            {log.data ? `${log.data.total.toLocaleString()} ${log.data.total === 1 ? "event" : "events"}` : ""}
          </span>
        </div>
        <TableStates
          isLoading={log.isLoading} isError={log.isError} error={log.error}
          isEmpty={!log.data || log.data.rows.length === 0}
          onRetry={() => { void log.refetch(); }}
          errorMessage="Could not load this store's activity."
          emptyTitle="No activity matches these filters."
        />
        {log.data && log.data.rows.length > 0 && (
          <>
            <AuditTable
              rows={log.data.rows}
              userTimezone={userTz}
              storeTimezone=""
            />
            <Pager
              page={log.data.page}
              totalPages={log.data.total_pages}
              onPage={setPage}
            />
          </>
        )}
      </Card>
    </Section>
  );
}
