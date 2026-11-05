import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  createBatch,
  updateBatch,
  useBatch,
  type BatchRow,
  type BatchWriteBody,
  BATCH_STATUSES,
  batchStatusLabel,
} from "../api/batches";
import { ApiError, apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Alert, Button, Card, Checkbox, DateInput, ErrorState,
  Field, FormActions, Input, KpiCard, KpiGrid, Loading, MoneyInput,
  PageHeader, PageShell, Section, Select, Textarea, useToast,
} from "../components/ui";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { useTransferChoices } from "../api/transfers";
import StoreListField from "../components/StoreListField";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./BatchForm.module.css";
import { todayIso } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { tn, useT } from "../i18n";

// Combined New/Edit form for ACH batches at /app/batches/new
// and /app/batches/:id/edit. Mirrors the legacy batch_form.html
// Jinja form. Server handles unique-ref check + cross-tenant
// 404 + admin-role gate.

// Blank new-batch form. A factory (not a const) so `form` and
// `baseline` each get an independent copy with the same values —
// keeping create-mode dirty detection honest.
function makeBlankBatch(): BatchWriteBody {
  return {
    ach_date:       todayIso(),
    // The store's first company once Settings' list loads.
    company:        "",
    batch_ref:      "",
    ach_amount:     0,
    transfer_dates: "",
    status:         BATCH_STATUSES[0],
    reconciled:     false,
    notes:          "",
  };
}

export default function BatchForm() {
  const t = useT();
  const { id } = useParams<{ id?: string }>();
  const isEdit = id !== undefined;
  const batchId = isEdit ? Number(id) : NaN;
  const navigate = useNavigate();
  const toast = useToast();
  const identity = getCurrentIdentity();

  const detail = useBatch(isEdit ? batchId : undefined);
  // Companies come from Settings → General, the same list as the
  // transfer form and the MSB daily book.
  const choices = useTransferChoices();
  const companies = choices.data?.companies;

  const [form, setForm] = useState<BatchWriteBody>(makeBlankBatch);
  // Baseline = last server-synced (or blank) form; drives the guard.
  const [baseline, setBaseline] = useState<BatchWriteBody>(makeBlankBatch);
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);

  // Hydrate form from existing batch on edit.
  useEffect(() => {
    if (!isEdit || !detail.data) return;
    const b = detail.data.batch;
    const hydrated: BatchWriteBody = {
      ach_date:       b.ach_date,
      company:        b.company,
      batch_ref:      b.batch_ref,
      ach_amount:     b.ach_amount,
      transfer_dates: b.transfer_dates,
      status:         b.status,
      reconciled:     b.reconciled,
      notes:          b.notes,
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local editable form + dirty baseline from server-fetched batch on edit
    setForm(hydrated);
    setBaseline(hydrated);
  }, [isEdit, detail.data]);

  // A new batch starts on the store's first company; set on both the
  // form and the baseline so loading the list is not an edit.
  useEffect(() => {
    if (isEdit || !companies?.length) return;
    const first = companies[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default the new batch's company from the server-fetched store list
    setForm((f) => (f.company ? f : { ...f, company: first }));
    setBaseline((b) => (b.company ? b : { ...b, company: first }));
  }, [isEdit, companies]);

  const isDirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const guard = useUnsavedGuard(isDirty && !busy, {
    message: t("batch.unsavedMessage"),
  });

  function set<K extends keyof BatchWriteBody>(
    key: K, value: BatchWriteBody[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null); setField(null);
    setBusy(true);
    try {
      const body: BatchWriteBody = {
        ...form,
        ach_amount: Number(form.ach_amount) || 0,
      };
      const result = isEdit
        ? await updateBatch(batchId, body)
        : await createBatch(body);
      toast({
        message: isEdit ? t("batch.updated") : t("batch.created"),
        tone: "success",
      });
      guard.proceed(() => navigate(`/batches`, { replace: true }));
      void result;
    } catch (err) {
      if (err instanceof ApiError) {
        setError(apiErrorMessage(err, t("batch.saveFailed")));
        if (err.body && typeof err.body === "object" && "detail" in err.body) {
          const detail = (err.body as Record<string, unknown>).detail;
          if (
            detail &&
            typeof detail === "object" &&
            "field" in (detail as Record<string, unknown>)
          ) {
            setField(String((detail as Record<string, unknown>).field));
          }
        }
      } else {
        setError(t("batch.saveFailed"));
      }
    } finally {
      setBusy(false);
    }
  }

  if (identity?.store_id == null) {
    return (
      <PageShell maxWidth="62rem">
        <PageHeader title={isEdit ? t("batch.editTitle") : t("batch.newTitle")} />
        <p>{t("batch.formSignIn")}</p>
      </PageShell>
    );
  }

  if (isEdit && (detail.isLoading || !detail.data)) {
    return <PageShell maxWidth="62rem"><Loading /></PageShell>;
  }

  return (
    <PageShell maxWidth="62rem">

      <PageCrumbs current={isEdit ? t("batch.editTitle") : t("batch.newCrumb")} />

      <PageHeader
        title={isEdit ? t("batch.editNumber", { id: batchId }) : t("batch.newTitle")}
        subtitle={t("batch.subtitle")}
      />

      {choices.isError && (
        <ErrorState
          message={t("batch.companiesFailed")}
          onRetry={() => { void choices.refetch(); }}
        />
      )}

      <form
        onSubmit={onSubmit}
        className="ds-form"
      >
        <Card>
          <div className={styles.fieldGrid}>
            <Field label={t("batch.achDate")} highlight={field === "ach_date"}>
              <DateInput required
                value={form.ach_date}
                onChange={(e) => set("ach_date", e.target.value)} />
            </Field>
            <StoreListField
              label={t("transfer.company")}
              options={companies}
              value={form.company}
              onChange={(v) => set("company", v)}
              loading={choices.isLoading || choices.isError}
              emptyText={t("transfer.noCompanies")}
            />
            <Field label={t("batch.batchReference")} highlight={field === "batch_ref"}>
              <Input type="text" required
                value={form.batch_ref}
                onChange={(e) => set("batch_ref", e.target.value)}
                placeholder={t("batch.refPlaceholder")} />
            </Field>
            <MoneyInput
              label={t("batch.achAmount")}
              value={form.ach_amount}
              onChange={(v) => set("ach_amount", v)}
            />
            <Field label={t("transfer.status")}>
              <Select value={form.status}
                onChange={(e) => set("status", e.target.value)}>
                {BATCH_STATUSES.map((s) => (
                  <option key={s} value={s}>{batchStatusLabel(s)}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("batch.reconciled")}>
              <Checkbox
                checked={form.reconciled}
                onChange={(v) => set("reconciled", v)}
              >
                {t("batch.isReconciled")}
              </Checkbox>
            </Field>
            <Field label={t("batch.transferDates")}>
              <Input type="text"
                value={form.transfer_dates}
                onChange={(e) => set("transfer_dates", e.target.value)}
                placeholder={t("batch.transferDatesPlaceholder")} />
            </Field>
          </div>
          <Field label={t("batch.notes")}>
            <Textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
            />
          </Field>
        </Card>

        {isEdit && detail.data && <ExpectedAch batch={detail.data.batch} />}

        {error && <Alert tone="error">{error}</Alert>}

        <FormActions guard={guard}>
          <Button
            type="button"
            tone="secondary"
            onClick={() => guard.confirmLeave(() => navigate("/batches"))}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit" busy={busy}
            disabled={busy || !form.batch_ref || !form.ach_date}
          >
            {busy ? t("transfer.saving") : isEdit ? t("transfer.saveChanges") : t("batch.create")}
          </Button>
        </FormActions>
      </form>
    </PageShell>
  );
}

/** What this ACH should withdraw, as last saved: the linked sends,
 *  less the credits the company gives on this invoice for the debit
 *  card sends and payouts of its previous batch. Those linked HERE
 *  are credited on the company's next batch. */
function ExpectedAch({ batch: b }: { batch: BatchRow }) {
  const t = useT();
  const from = b.card_credit_from
    ? t("batch.fromBatch", { ref: b.card_credit_from })
    : t("batch.noneFromPrevious");
  const card = fmtMoney2(b.card_credit_next);
  const payout = fmtMoney2(b.payout_credit_next);
  const hasCard = b.card_credit_next > 0;
  const hasPayout = b.payout_credit_next > 0;
  // Whole phrases per case, never glued: word order and agreement
  // differ between the languages.
  const what = hasCard && hasPayout
    ? t("batch.nextBoth", { card, payout })
    : hasCard
      ? t("batch.nextCard", { card })
      : hasPayout
        ? t("batch.nextPayout", { payout })
        : "";
  const parts = (hasCard ? 1 : 0) + (hasPayout ? 1 : 0);
  return (
    <Section title={t("batch.expectedAch")}>
      <KpiGrid minWidth="10rem">
        <KpiCard
          label={t("batch.linkedSends")}
          value={fmtMoney2(b.transfers_total)}
          sub={tn("transfer.count", b.transfer_count, fmtNumber)}
        />
        <KpiCard
          label={t("batch.cardCredit")}
          value={fmtMoney2(-b.card_credit)}
          sub={from}
        />
        <KpiCard
          label={t("batch.payoutCredit")}
          value={fmtMoney2(-b.payout_credit)}
          sub={from}
        />
        <KpiCard label={t("batch.expectedAch")} value={fmtMoney2(b.expected_ach)} tone="primary" />
        <KpiCard
          label={t("batch.variance")}
          value={fmtMoney2(b.variance)}
          tone={b.variance < 0 ? "negative" : "neutral"}
          sub={t("batch.varianceSub")}
        />
      </KpiGrid>
      {what && (
        <p className={styles.cardNote}>
          {b.card_credit_next_to
            ? tn("batch.creditedOnBatch", parts, String, { what, ref: b.card_credit_next_to })
            : tn("batch.creditedNext", parts, String, { what })}
        </p>
      )}
    </Section>
  );
}
