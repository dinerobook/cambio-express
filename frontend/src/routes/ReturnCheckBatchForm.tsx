import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  createReturnCheckBatch, type ReturnCheckBatchCheckBody,
} from "../api/returnChecks";
import { apiErrorMessage } from "../lib/api";
import { todayIso } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { useDirtyBaseline, useUnsavedGuard } from "../lib/useUnsavedGuard";
import {
  Alert, Button, Card, DateInput, Field, FormActions, Input, MoneyInput,
  PageHeader, PageShell, SectionTitle, Textarea, useToast,
} from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import { PartyNameInput } from "../components/PartyNameInput";
import styles from "./ReturnCheckForm.module.css";
import { tn, useT } from "../i18n";

// New batch at /app/return-checks/batches/new: the checks the bank
// sent back together, entered once. The returned date and the bank
// reference are typed once for the whole batch; each row is one
// check. Saving creates the batch and every check (pending) in one
// go, then opens the batch.

type CheckDraft = Omit<ReturnCheckBatchCheckBody, "notes">;

function emptyCheck(): CheckDraft {
  return {
    customer_name: "", company_name: "", check_number: "", payer_bank: "",
    routing_number: "", account_number: "", amount: 0, return_check_fee: 0,
  };
}

// Routing / account fields keep digits only, so a pasted "021-000-021"
// still saves.
const digits = (v: string) => v.replace(/\D+/g, "");

export default function ReturnCheckBatchForm() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [returnedOn, setReturnedOn] = useState(() => todayIso());
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [checks, setChecks] = useState<CheckDraft[]>(() => [emptyCheck()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { dirty, markSaved } = useDirtyBaseline({ returnedOn, reference, notes, checks });
  const guard = useUnsavedGuard(dirty && !busy, { message: t("returnCheck.batchUnsaved") });

  function setCheck<K extends keyof CheckDraft>(i: number, key: K, value: CheckDraft[K]) {
    setChecks((rows) => rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  }

  const total = checks.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  const ready = Boolean(returnedOn) && checks.every(
    (c) => c.customer_name.trim() && c.company_name.trim() && Number(c.amount) > 0,
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!ready) {
      setError(t("returnCheck.batchIncomplete"));
      return;
    }
    setBusy(true);
    try {
      const saved = await createReturnCheckBatch({
        returned_on: returnedOn, reference, notes,
        checks: checks.map((c) => ({
          ...c,
          amount: Number(c.amount) || 0,
          return_check_fee: Number(c.return_check_fee) || 0,
          notes: "",
        })),
      });
      void qc.invalidateQueries({ queryKey: ["return-checks"] });
      toast({
        message: tn("returnCheck.batchSaved", saved.checks?.length ?? checks.length, fmtNumber),
        tone: "success",
      });
      markSaved();
      guard.proceed(() => navigate(`/return-checks/batches/${saved.batch.id}`, { replace: true }));
    } catch (err) {
      setError(apiErrorMessage(err, t("returnCheck.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell maxWidth="62rem">
      <PageCrumbs current={t("returnCheck.newBatchTitle")} />
      <PageHeader title={t("returnCheck.newBatchTitle")} subtitle={t("returnCheck.newBatchSubtitle")} />

      <form onSubmit={onSubmit} className="ds-form">
        <Card>
          <SectionTitle>{t("returnCheck.batchDetails")}</SectionTitle>
          <div className={styles.fieldGrid}>
            <Field label={t("returnCheck.returnedOn")}>
              <DateInput required value={returnedOn} onChange={(e) => setReturnedOn(e.target.value)} />
            </Field>
            <Field label={t("returnCheck.referenceOptional")} hint={t("returnCheck.referenceHint")}>
              <Input type="text" maxLength={80} value={reference}
                onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
          <Field label={t("batch.notes")}>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </Card>

        <Card>
          <SectionTitle>{t("returnCheck.checksInBatch")}</SectionTitle>
          {checks.map((c, i) => (
            <fieldset key={i} className={styles.batchRow}>
              <legend className={styles.batchRowTitle}>
                {t("returnCheck.checkN", { n: i + 1 })}
              </legend>
              <div className={styles.fieldGrid}>
                <Field label={t("returnCheck.customerName")}>
                  <PartyNameInput by="customer" required value={c.customer_name}
                    onChange={(v) => setCheck(i, "customer_name", v)} />
                </Field>
                <Field label={t("returnCheck.companyName")}>
                  <PartyNameInput by="company" required value={c.company_name}
                    onChange={(v) => setCheck(i, "company_name", v)} />
                </Field>
                <Field label={t("returnCheck.checkNumber")}>
                  <Input type="text" maxLength={40} value={c.check_number ?? ""}
                    onChange={(e) => setCheck(i, "check_number", e.target.value)} />
                </Field>
                <Field label={t("returnCheck.payerBank")}>
                  <Input type="text" maxLength={120} value={c.payer_bank ?? ""}
                    onChange={(e) => setCheck(i, "payer_bank", e.target.value)} />
                </Field>
                <Field label={t("returnCheck.routingOptional")}>
                  <Input type="text" inputMode="numeric" maxLength={9} value={c.routing_number ?? ""}
                    onChange={(e) => setCheck(i, "routing_number", digits(e.target.value))} />
                </Field>
                <Field label={t("returnCheck.accountOptional")}>
                  <Input type="text" inputMode="numeric" maxLength={20} value={c.account_number ?? ""}
                    onChange={(e) => setCheck(i, "account_number", digits(e.target.value))} />
                </Field>
                <MoneyInput label={t("dash.amount")} value={c.amount}
                  onChange={(v) => setCheck(i, "amount", v)} />
                <MoneyInput label={t("returnCheck.feeOptional")} value={c.return_check_fee ?? 0}
                  onChange={(v) => setCheck(i, "return_check_fee", v)} />
              </div>
              {checks.length > 1 && (
                <div className={styles.batchRowActions}>
                  <Button type="button" tone="secondary" size="sm"
                    onClick={() => setChecks((rows) => rows.filter((_, j) => j !== i))}>
                    {t("returnCheck.removeCheck", { n: i + 1 })}
                  </Button>
                </div>
              )}
            </fieldset>
          ))}
          <div className={styles.batchFooter}>
            <Button type="button" tone="secondary" size="sm"
              disabled={checks.length >= 50}
              onClick={() => setChecks((rows) => [...rows, emptyCheck()])}>
              {t("returnCheck.addCheckRow")}
            </Button>
            <span className={styles.statusMeta}>
              {tn("returnCheck.batchTotal", checks.length, fmtNumber, { amount: fmtMoney2(total) })}
            </span>
          </div>
        </Card>

        {error && <Alert tone="error">{error}</Alert>}

        <FormActions guard={guard}>
          <Button type="button" tone="secondary"
            onClick={() => guard.confirmLeave(() => navigate("/return-checks/batches", { replace: true }))}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={busy} disabled={busy || !ready}>
            {busy ? t("transfer.saving") : t("returnCheck.saveBatch")}
          </Button>
        </FormActions>
      </form>
    </PageShell>
  );
}
