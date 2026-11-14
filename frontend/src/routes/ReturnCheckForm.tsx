import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  batchName,
  createReturnCheck,
  createReturnCheckPayment,
  deleteReturnCheckPayment,
  markFraud,
  RETURN_CHECK_PAYMENT_METHODS,
  RETURN_CHECK_STATUS_TONES,
  paymentMethodLabel,
  returnCheckStatusLabel,
  markLoss,
  reopenReturnCheck,
  updateReturnCheck,
  useReturnCheck,
  useReturnCheckBatch,
  useReturnCheckBatches,
  useReturnCheckPayments,
  type ReturnCheckPaymentRow,
  type ReturnCheckWriteBody,
} from "../api/returnChecks";
import { ApiError, apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import { fmtMoney2 } from "../lib/formatters";
import {
  Alert, Button, Card, ConfirmDialog, DateInput, EmptyState, ErrorState,
  Field,
  FormActions, Input, Loading, MoneyInput, PageHeader, PageShell, Pill,
  SectionTitle, Select, Table, Textarea, tdStyle, thStyle,
  useToast,
} from "../components/ui";
import styles from "./ReturnCheckForm.module.css";
import { formatDate, todayIso } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { PartyNameInput } from "../components/PartyNameInput";
import { tNodes, useT, type MessageKey } from "../i18n";

/** A status change: what it does and the words its button and
 *  confirm popup use. */
interface Transition {
  fn: (id: number) => Promise<unknown>;
  label: MessageKey;
  title: MessageKey;
  failed: MessageKey;
  reopen: boolean;
}
const MARK_LOSS = {
  fn: markLoss, label: "returnCheck.markLoss", title: "returnCheck.markLossTitle",
  failed: "returnCheck.markLossFailed", reopen: false,
} as const satisfies Transition;
const MARK_FRAUD = {
  fn: markFraud, label: "returnCheck.markFraud", title: "returnCheck.markFraudTitle",
  failed: "returnCheck.markFraudFailed", reopen: false,
} as const satisfies Transition;
const REOPEN = {
  fn: reopenReturnCheck, label: "returnCheck.reopen", title: "returnCheck.reopenTitle",
  failed: "returnCheck.reopenFailed", reopen: true,
} as const satisfies Transition;

// Combined New/Edit form for return checks at /app/return-checks/new
// and /app/return-checks/:id/edit. Edit variant also surfaces
// status-transition buttons (Mark loss / Mark fraud / Reopen) and
// an existing-payments table.
//
// Per-payment write endpoints (record / delete) ship in a follow-
// up PR — here we only show what's already on file.

export default function ReturnCheckForm() {
  const t = useT();
  const { id } = useParams<{ id?: string }>();
  const isEdit = id !== undefined;
  const rcId = isEdit ? Number(id) : NaN;
  const navigate = useNavigate();
  const toast = useToast();
  const identity = getCurrentIdentity();
  const queryClient = useQueryClient();

  const detail = useReturnCheck(isEdit ? rcId : undefined);
  const payments = useReturnCheckPayments(isEdit ? rcId : undefined);
  // "Add check" on a batch page opens this form with ?batch=<id>.
  const [search] = useSearchParams();
  const presetBatch = !isEdit && Number(search.get("batch")) > 0
    ? Number(search.get("batch")) : null;
  // The batch picker: the store's latest batches, plus the check's own
  // batch (or the preset one) when it is older than that page.
  const batches = useReturnCheckBatches({ perPage: 100 });

  const emptyForm: ReturnCheckWriteBody = {
    bounced_on:       todayIso(),
    customer_name:    "",
    company_name:     "",
    check_number:     "",
    payer_bank:       "",
    amount:           0,
    return_check_fee: 0,
    notes:            "",
    batch_id:         presetBatch,
    routing_number:   "",
    account_number:   "",
  };
  const [form, setForm] = useState<ReturnCheckWriteBody>(emptyForm);
  // Baseline = last-saved values; the form is "dirty" when it drifts
  // from this. Seeded from the server row on edit, reset after a save.
  const [baseline, setBaseline] = useState<ReturnCheckWriteBody>(emptyForm);
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !detail.data) return;
    const r = detail.data.return_check;
    const hydrated: ReturnCheckWriteBody = {
      bounced_on:       r.bounced_on,
      customer_name:    r.customer_name,
      company_name:     r.company_name,
      check_number:     r.check_number,
      payer_bank:       r.payer_bank,
      amount:           r.amount,
      return_check_fee: r.return_check_fee,
      notes:            r.notes,
      batch_id:         r.batch_id ?? null,
      routing_number:   r.routing_number ?? "",
      account_number:   r.account_number ?? "",
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local editable form + dirty baseline from server-fetched return-check on edit
    setForm(hydrated);
    setBaseline(hydrated);
  }, [isEdit, detail.data]);

  const isDirty = JSON.stringify(form) !== JSON.stringify(baseline);
  // Browser prompt on close/refresh + in-app discard confirm on Cancel.
  const guard = useUnsavedGuard(isDirty && !busy, {
    message: t("returnCheck.unsavedMessage"),
  });

  const ownBatch = useReturnCheckBatch(form.batch_id ?? undefined);
  const batchOptions = [...(batches.data?.rows ?? [])];
  const picked = ownBatch.data?.batch;
  if (picked && !batchOptions.some((b) => b.id === picked.id)) batchOptions.unshift(picked);

  // Back to the batch the form was opened from, else the list.
  const backTo = presetBatch ? `/return-checks/batches/${presetBatch}` : "/return-checks";
  function leave() {
    navigate(backTo, { replace: true });
  }
  function onCancel() {
    guard.confirmLeave(leave);
  }

  function set<K extends keyof ReturnCheckWriteBody>(
    key: K, value: ReturnCheckWriteBody[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null); setField(null);
    setBusy(true);
    try {
      // In a batch, the server dates the check with the batch's day.
      const day = form.batch_id != null && picked ? picked.returned_on : form.bounced_on;
      const body: ReturnCheckWriteBody = {
        ...form,
        bounced_on: day,
        amount: Number(form.amount) || 0,
        return_check_fee: Number(form.return_check_fee) || 0,
      };
      if (isEdit) await updateReturnCheck(rcId, body);
      else        await createReturnCheck(body);
      // The list (and this check's detail) are cached; without this
      // the list shows the old row until the cache goes stale.
      void queryClient.invalidateQueries({ queryKey: ["return-checks"] });
      toast({
        message: isEdit ? t("returnCheck.updated") : t("returnCheck.recorded"),
        tone: "success",
      });
      guard.proceed(() => navigate(backTo, { replace: true }));
    } catch (err) {
      if (err instanceof ApiError) {
        setError(apiErrorMessage(err, t("returnCheck.saveFailed")));
        if (err.body && typeof err.body === "object" && "detail" in err.body) {
          const d = (err.body as Record<string, unknown>).detail;
          if (
            d && typeof d === "object" && "field" in (d as Record<string, unknown>)
          ) {
            setField(String((d as Record<string, unknown>).field));
          }
        }
      } else {
        setError(t("returnCheck.saveFailed"));
      }
    } finally {
      setBusy(false);
    }
  }

  // Status transitions are gated through a ConfirmDialog.  The
  // pending action carries the API fn + the human label so the
  // dialog body can render the right wording.
  const [pendingTransition, setPendingTransition] =
    useState<Transition | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  async function doTransition() {
    if (!isEdit || !pendingTransition) return;
    const { fn, failed } = pendingTransition;
    setTransitionError(null); setBusy(true);
    try {
      await fn(rcId);
      // The status moved: refresh this check AND the list behind it.
      await queryClient.invalidateQueries({ queryKey: ["return-checks"] });
      setPendingTransition(null);
    } catch (err) {
      setTransitionError(
        apiErrorMessage(err, t(failed)),
      );
    } finally {
      setBusy(false);
    }
  }

  if (identity?.store_id == null) {
    return (
      <PageShell maxWidth="62rem">
        <PageHeader title={isEdit ? t("returnCheck.editTitle") : t("returnCheck.newTitle")} />
        <p>{t("returnCheck.formSignIn")}</p>
      </PageShell>
    );
  }

  if (isEdit && detail.isError && !detail.data) {
    return (
      <PageShell maxWidth="62rem">
        <PageHeader title={t("returnCheck.number", { id: rcId })} />
        <ErrorState
          message={t("returnCheck.loadFailed")}
          onRetry={() => void detail.refetch()}
          busy={detail.isFetching}
        />
      </PageShell>
    );
  }

  if (isEdit && (detail.isLoading || !detail.data)) {
    return <PageShell maxWidth="62rem"><Loading /></PageShell>;
  }

  const status = isEdit ? detail.data?.return_check.status ?? "pending" : "pending";
  const recovered = isEdit ? detail.data?.return_check.recovered_total ?? 0 : 0;
  // Total the customer owes = face amount + any returned-check fee.
  // The recovery workflow (remaining balance, payment cap, the
  // "recovered of X" strip) pays down to this, not the bare amount.
  const totalDue = (Number(form.amount) || 0) + (Number(form.return_check_fee) || 0);

  return (
    <PageShell maxWidth="62rem">

      <PageCrumbs current={isEdit ? t("returnCheck.editTitle") : t("returnCheck.newTitle")} />

      <PageHeader
        title={isEdit ? t("returnCheck.number", { id: rcId }) : t("returnCheck.newTitle")}
        subtitle={t("returnCheck.subtitle")}
      />

      {isEdit && (
        <div className={styles.statusBar}>
          <div className={styles.statusBarInfo}>
            <Pill tone={RETURN_CHECK_STATUS_TONES[status] ?? "neutral"} dot>
              {returnCheckStatusLabel(status)}
            </Pill>
            <span className={styles.statusMeta}>
              {tNodes("returnCheck.recoveredOf", {
                recovered: <span className={styles.mono}>{fmtMoney2(recovered)}</span>,
                total: <span className={styles.mono}>{fmtMoney2(totalDue)}</span>,
              })}
            </span>
          </div>
          <div className={styles.transitionRow}>
            {status === "pending" && (
              <>
                <Button
                  tone="danger" size="sm"
                  onClick={() => setPendingTransition(MARK_LOSS)}
                  disabled={busy}
                >
                  {t(MARK_LOSS.label)}
                </Button>
                <Button
                  tone="danger" size="sm"
                  onClick={() => setPendingTransition(MARK_FRAUD)}
                  disabled={busy}
                >
                  {t(MARK_FRAUD.label)}
                </Button>
              </>
            )}
            {/* Reopen is only for written-off checks (loss / fraud) —
                the "customer paid after we wrote it off" case. A
                Recovered check has no Reopen: to undo it, remove a
                payment below (which reverts it to pending). */}
            {(status === "loss" || status === "fraud") && (
              <Button
                tone="secondary" size="sm"
                onClick={() => setPendingTransition(REOPEN)}
                disabled={busy}
              >
                {t(REOPEN.label)}
              </Button>
            )}
          </div>
        </div>
      )}

      {isEdit && (
        <Card>
          <SectionTitle>{t("returnCheck.recoveryPayments")}</SectionTitle>
          {status === "pending" && (
            <RecordPaymentForm
              rcId={rcId}
              remaining={Math.max(0, totalDue - recovered)}
              disabled={busy}
            />
          )}
          {(status === "loss" || status === "fraud") && (
            <p className={styles.statusLine}>
              {tNodes("returnCheck.closedAs", {
                status: <strong>{returnCheckStatusLabel(status).toLowerCase()}</strong>,
              })}
            </p>
          )}
          {payments.isLoading && <Loading />}
          {payments.data && payments.data.payments.length === 0 && (
            <EmptyState title={t("returnCheck.noPayments")} />
          )}
          {payments.data && payments.data.payments.length > 0 && (
            <PaymentsTable
              rows={payments.data.payments}
              rcId={rcId}
              canDelete={status !== "loss" && status !== "fraud"}
            />
          )}
        </Card>
      )}

      <form
        onSubmit={onSubmit}
        className="ds-form"
      >
        <Card>
          <SectionTitle>{t("returnCheck.checkDetails")}</SectionTitle>
          <div className={styles.fieldGrid}>
            <Field label={t("returnCheck.batchOptional")} hint={t("returnCheck.batchPickHint")}>
              <Select
                value={form.batch_id != null ? String(form.batch_id) : ""}
                onChange={(e) => set("batch_id", e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t("returnCheck.noBatch")}</option>
                {batchOptions.map((b) => (
                  <option key={b.id} value={String(b.id)}>{batchName(b, formatDate)}</option>
                ))}
              </Select>
            </Field>
            {/* A check in a batch came back on the batch's day: the
                date field gives way to it (a field that does not
                apply disappears). */}
            {form.batch_id == null && (
              <Field label={t("returnCheck.bouncedOn")} highlight={field === "bounced_on"}>
                <DateInput required
                  value={form.bounced_on}
                  onChange={(e) => set("bounced_on", e.target.value)} />
              </Field>
            )}
            <Field label={t("returnCheck.customerName")} highlight={field === "customer_name"}>
              <PartyNameInput by="customer" required
                value={form.customer_name}
                onChange={(v) => set("customer_name", v)} />
            </Field>
            <Field label={t("returnCheck.companyName")} highlight={field === "company_name"}>
              <PartyNameInput by="company" required
                value={form.company_name}
                onChange={(v) => set("company_name", v)} />
            </Field>
            <Field label={t("returnCheck.checkNumber")}>
              <Input type="text"
                value={form.check_number ?? ""}
                onChange={(e) => set("check_number", e.target.value)} />
            </Field>
            <Field label={t("returnCheck.payerBank")}>
              <Input type="text"
                value={form.payer_bank ?? ""}
                onChange={(e) => set("payer_bank", e.target.value)} />
            </Field>
            <Field label={t("returnCheck.routingOptional")} highlight={field === "routing_number"}>
              <Input type="text" inputMode="numeric" maxLength={9}
                value={form.routing_number ?? ""}
                onChange={(e) => set("routing_number", e.target.value.replace(/\D+/g, ""))} />
            </Field>
            <Field label={t("returnCheck.accountOptional")} highlight={field === "account_number"}>
              <Input type="text" inputMode="numeric" maxLength={20}
                value={form.account_number ?? ""}
                onChange={(e) => set("account_number", e.target.value.replace(/\D+/g, ""))} />
            </Field>
            <MoneyInput
              label={t("dash.amount")}
              value={form.amount}
              onChange={(v) => set("amount", v)}
              error={field === "amount" ? t("returnCheck.invalidAmount") : undefined}
            />
            <MoneyInput
              label={t("returnCheck.feeOptional")}
              value={form.return_check_fee ?? 0}
              onChange={(v) => set("return_check_fee", v)}
              error={field === "return_check_fee" ? t("returnCheck.invalidFee") : undefined}
            />
          </div>
          <Field label={t("batch.notes")}>
            <Textarea
              value={form.notes ?? ""}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
            />
          </Field>
        </Card>

        {error && <Alert tone="error">{error}</Alert>}

        <FormActions guard={guard}>
          <Button type="button" tone="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit" busy={busy}
            disabled={busy || !form.customer_name || !form.company_name
              || (form.batch_id == null ? !form.bounced_on : !picked)}
          >
            {busy ? t("transfer.saving") : isEdit ? t("transfer.saveChanges") : t("returnCheck.create")}
          </Button>
        </FormActions>
      </form>

      <ConfirmDialog
        open={pendingTransition != null}
        title={pendingTransition ? t(pendingTransition.title) : ""}
        message={
          pendingTransition?.reopen
            ? t("returnCheck.reopenMessage")
            : t("returnCheck.finalMessage")
        }
        confirmLabel={pendingTransition ? t(pendingTransition.label) : t("common.confirm")}
        confirmTone={pendingTransition?.reopen ? "primary" : "danger"}
        busy={busy}
        error={transitionError}
        onConfirm={() => { void doTransition(); }}
        onCancel={() => { setPendingTransition(null); setTransitionError(null); }}
      />
    </PageShell>
  );
}


function RecordPaymentForm({
  rcId, remaining, disabled,
}: {
  rcId: number;
  remaining: number;
  disabled: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [paidOn,  setPaidOn]  = useState(() => todayIso());
  const [amount,  setAmount]  = useState(0);
  const [method,  setMethod]  = useState<string>(RETURN_CHECK_PAYMENT_METHODS[0]);
  const [note,    setNote]    = useState("");
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // The remaining cap is enforced server-side too, but render the
  // limit hint so a cashier doesn't tab over to a calculator.
  const cap = remaining;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError(t("daily.amountPositive"));
      return;
    }
    const amt = amount;
    if (cap <= 0) {
      setError(t("returnCheck.fullyRecovered"));
      return;
    }
    setBusy(true);
    try {
      await createReturnCheckPayment(rcId, {
        paid_on: paidOn,
        amount: amt,
        method,
        note,
      });
      // Refetch parent + payments so the totals strip + table flip.
      // Detail, payments AND the list: a payment moves the check's
      // recovered total and can flip it to recovered.
      void qc.invalidateQueries({ queryKey: ["return-checks"] });
      setAmount(0); setNote("");
    } catch (err) {
      setError(
        apiErrorMessage(err, t("returnCheck.recordFailed")),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={styles.paymentForm}>
      <div className={styles.paymentFormGrid}>
        <Field label={t("transfer.date")}>
          <DateInput
            required
            value={paidOn}
            onChange={(e) => setPaidOn(e.target.value)}
            disabled={busy || disabled}
          />
        </Field>
        <MoneyInput
          label={t("dash.amount")}
          hint={cap > 0 ? t("returnCheck.upTo", { amount: fmtMoney2(cap) }) : undefined}
          value={amount}
          onChange={setAmount}
          disabled={busy || disabled || cap <= 0}
        />
        <Field label={t("returnCheck.method")}>
          <Select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            disabled={busy || disabled}
          >
            {RETURN_CHECK_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>{paymentMethodLabel(m)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("returnCheck.noteOptional")}>
          <Input
            type="text" maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy || disabled}
            placeholder={t("returnCheck.notePlaceholder")}
          />
        </Field>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className={styles.paymentFormActions}>
        <Button
          type="submit" busy={busy}
          disabled={busy || disabled || cap <= 0 || !amount}
        >
          {busy ? t("returnCheck.recording") : t("returnCheck.recordPayment")}
        </Button>
      </div>
    </form>
  );
}


function PaymentsTable({
  rows, rcId, canDelete,
}: {
  rows: ReturnCheckPaymentRow[];
  rcId: number;
  canDelete: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] =
    useState<ReturnCheckPaymentRow | null>(null);

  async function doRemove() {
    if (!pendingRemove) return;
    const p = pendingRemove;
    setError(null);
    setBusyId(p.id);
    try {
      await deleteReturnCheckPayment(rcId, p.id);
      // Detail, payments AND the list: a payment moves the check's
      // recovered total and can flip it to recovered.
      void qc.invalidateQueries({ queryKey: ["return-checks"] });
      setPendingRemove(null);
    } catch (err) {
      setError(
        apiErrorMessage(err, t("returnCheck.removeFailed")),
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Table>
        <thead>
          <tr>
            <th style={thStyle}>{t("returnCheck.paidOn")}</th>
            <th style={{ ...thStyle, textAlign: "right" }}>{t("dash.amount")}</th>
            <th style={thStyle}>{t("returnCheck.method")}</th>
            <th style={thStyle}>{t("returnCheck.notes")}</th>
            {canDelete && <th style={thStyle} aria-label={t("common.actions")} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td style={tdStyle}>
                <span className={styles.monoMuted}>{p.paid_on}</span>
              </td>
              <td style={{ ...tdStyle, textAlign: "right" }}>
                <span className={styles.mono}>{fmtMoney2(p.amount)}</span>
              </td>
              <td style={tdStyle}>{paymentMethodLabel(p.method)}</td>
              <td style={tdStyle}>{p.notes || "—"}</td>
              {canDelete && (
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  <Button
                    tone="danger" size="sm"
                    perm="return_checks.delete"
                    busy={busyId === p.id}
                    disabled={busyId !== null}
                    onClick={() => setPendingRemove(p)}
                  >
                    {busyId === p.id ? t("returnCheck.removing") : t("returnCheck.remove")}
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
      <ConfirmDialog
        open={pendingRemove != null}
        title={t("returnCheck.removeTitle")}
        message={
          pendingRemove
            ? t("returnCheck.removeMessage", {
                amount: fmtMoney2(pendingRemove.amount), date: pendingRemove.paid_on,
              })
            : ""
        }
        confirmLabel={t("returnCheck.remove")}
        confirmTone="danger"
        busy={busyId != null}
        error={error}
        onConfirm={() => { void doRemove(); }}
        onCancel={() => { setPendingRemove(null); setError(null); }}
      />
    </>
  );
}


