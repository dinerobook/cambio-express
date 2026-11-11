// Bad checks: a cashed check the bank sent back. A manager marks it
// from the check's row (ReportBadCheckDialog); the bad check's popup
// (BadCheckModal) shows what is owed, records the customer's
// payments and lets a manager write off the rest.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("Bad checks").

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  addBadCheckPayment, BAD_CHECK_REASONS, BAD_CHECK_STATUS_TONES,
  badCheckReasonLabel, badCheckStatusLabel, reportBadCheck, useBadCheck,
  writeOffBadCheck, type BadCheckReason, type CashedCheckRow,
} from "../api/checkCashing";
import {
  Alert, Button, ConfirmDialog, DateInput, Empty, ErrorState, Field, Input,
  KpiCard, KpiGrid, Loading, Modal, MoneyInput, Pill, SectionTitle, Select,
  useToast,
} from "./ui";
import { useT } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { formatDate, todayIso } from "../lib/datetime";
import { fmtMoney2 } from "../lib/formatters";
import styles from "../routes/CheckCashing.module.css";

/** A manager marks a cashed check as sent back by the bank. */
export function ReportBadCheckDialog({
  check, onClose,
}: {
  check: CashedCheckRow | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<BadCheckReason>("nsf");
  const [returnedOn, setReturnedOn] = useState(todayIso());
  const [fee, setFee] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownFor, setShownFor] = useState<number | null>(null);

  // A fresh form each time the dialog opens for a check.
  if (check && check.id !== shownFor) {
    setShownFor(check.id);
    setReason("nsf"); setReturnedOn(todayIso()); setFee(0); setNote(""); setError(null);
  }

  async function confirm() {
    if (!check) return;
    setBusy(true); setError(null);
    try {
      await reportBadCheck(check.id, {
        reason, returned_on: returnedOn, fee, note: note.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
      toast({ message: t("checkCashing.reportedBad"), tone: "success" });
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.reportBadFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={check != null}
      title={t("checkCashing.reportBadTitle")}
      message={check ? (
        <>
          <p className={styles.note}>
            {t("checkCashing.reportBadMessage", {
              amount: fmtMoney2(check.amount), name: check.customer_name,
            })}
          </p>
          <div className={styles.fieldGrid}>
            <Field label={t("checkCashing.reportBadReason")}>
              <Select
                value={reason}
                onChange={(e) => setReason(e.target.value as BadCheckReason)}
              >
                {BAD_CHECK_REASONS.map((r) => (
                  <option key={r} value={r}>{badCheckReasonLabel(r)}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("checkCashing.reportBadDate")}>
              <DateInput
                value={returnedOn} required
                onChange={(e) => setReturnedOn(e.target.value)}
              />
            </Field>
            <Field label={t("checkCashing.reportBadFee")} hint={t("checkCashing.reportBadFeeHint")}>
              <MoneyInput
                value={fee} onChange={setFee} fullWidth
                aria-label={t("checkCashing.reportBadFee")}
              />
            </Field>
            <Field label={t("checkCashing.reportBadNote")}>
              <Input
                type="text" maxLength={255}
                value={note} onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>
        </>
      ) : ""}
      confirmLabel={t("checkCashing.reportBadConfirm")}
      confirmTone="danger"
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  );
}

/** One bad check: what is owed, the payments, and the two actions. */
export function BadCheckModal({
  id, onClose,
}: {
  id: number | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detail = useBadCheck(id);
  const [amount, setAmount] = useState(0);
  const [payNote, setPayNote] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [writingOff, setWritingOff] = useState(false);
  const [offNote, setOffNote] = useState("");
  const [offError, setOffError] = useState<string | null>(null);
  const [offBusy, setOffBusy] = useState(false);

  function close() {
    setAmount(0); setPayNote(""); setPayError(null);
    setWritingOff(false); setOffNote(""); setOffError(null);
    onClose();
  }

  const data = detail.data;
  const bad = data?.bad_check;

  async function pay() {
    if (!bad) return;
    if (amount <= 0) { setPayError(t("checkCashing.badPayNeedsAmount")); return; }
    if (amount > bad.balance) {
      setPayError(t("checkCashing.badPayTooMuch", { amount: fmtMoney2(bad.balance) }));
      return;
    }
    setPaying(true); setPayError(null);
    try {
      await addBadCheckPayment(bad.id, { amount, note: payNote.trim() });
      await queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
      toast({ message: t("checkCashing.badPaymentSaved"), tone: "success" });
      setAmount(0); setPayNote("");
    } catch (err) {
      setPayError(apiErrorMessage(err, t("checkCashing.badPayFailed")));
    } finally {
      setPaying(false);
    }
  }

  async function writeOff() {
    if (!bad) return;
    if (!offNote.trim()) { setOffError(t("checkCashing.badWriteOffNeedsNote")); return; }
    setOffBusy(true); setOffError(null);
    try {
      await writeOffBadCheck(bad.id, offNote.trim());
      await queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
      toast({ message: t("checkCashing.badWrittenOff"), tone: "success" });
      setWritingOff(false); setOffNote("");
    } catch (err) {
      setOffError(apiErrorMessage(err, t("checkCashing.badWriteOffFailed")));
    } finally {
      setOffBusy(false);
    }
  }

  let body;
  if (detail.isError && !data) {
    body = (
      <ErrorState
        message={apiErrorMessage(detail.error, t("checkCashing.loadFailed"))}
        onRetry={() => void detail.refetch()}
        busy={detail.isFetching}
      />
    );
  } else if (!data || !bad) {
    body = <Loading />;
  } else {
    const summaryWords = {
      company: bad.company_name, number: bad.check_number,
      amount: fmtMoney2(bad.amount), cashed: formatDate(bad.cashed_on),
      store: bad.store_name, returned: formatDate(bad.returned_on),
      reason: badCheckReasonLabel(bad.reason),
    };
    body = (
      <div className={styles.reviewStack}>
        <p className={styles.statusCell}>
          <Pill tone={BAD_CHECK_STATUS_TONES[bad.status] ?? "neutral"}>
            {badCheckStatusLabel(bad.status)}
          </Pill>
          <span className={styles.note}>
            {bad.check_number
              ? t("checkCashing.badCheckSummary", summaryWords)
              : t("checkCashing.badCheckSummaryNoNumber", summaryWords)}
          </span>
        </p>
        {bad.note && <p className={styles.note}>{bad.note}</p>}
        {bad.status === "written_off" && (
          <Alert tone="error">
            {t("checkCashing.badWrittenOffNote", { note: bad.write_off_note })}
          </Alert>
        )}
        <KpiGrid minWidth="8.5rem">
          <KpiCard
            label={t("checkCashing.badOwed")} value={fmtMoney2(bad.owed)}
            sub={t("checkCashing.badOwedSub", {
              amount: fmtMoney2(bad.amount), fee: fmtMoney2(bad.fee),
            })}
          />
          <KpiCard label={t("checkCashing.badPaid")} value={fmtMoney2(bad.paid)} />
          <KpiCard
            label={t("checkCashing.badLeft")} value={fmtMoney2(bad.balance)}
            tone={bad.status === "open" && bad.balance > 0 ? "warning" : "neutral"}
          />
        </KpiGrid>

        <SectionTitle>{t("checkCashing.badPayments")}</SectionTitle>
        {data.payments.length === 0 ? (
          <Empty>{t("checkCashing.badNoPayments")}</Empty>
        ) : data.payments.map((p) => (
          <div key={p.id} className={styles.idRow}>
            <div className={styles.idText}>
              <strong>{fmtMoney2(p.amount)}</strong>
              <span className={styles.muted}>
                {[formatDate(p.paid_on), p.store_name, p.taken_by, p.note]
                  .filter(Boolean).join(" · ")}
              </span>
            </div>
          </div>
        ))}

        {data.can_pay && (
          <form
            className={styles.fieldGrid}
            onSubmit={(e) => { e.preventDefault(); void pay(); }}
          >
            <Field label={t("checkCashing.badPayAmount")} error={payError ?? undefined}>
              <MoneyInput
                value={amount} onChange={setAmount} fullWidth
                aria-label={t("checkCashing.badPayAmount")}
              />
            </Field>
            <Field label={t("checkCashing.badPayNote")}>
              <Input
                type="text" maxLength={255}
                value={payNote} onChange={(e) => setPayNote(e.target.value)}
              />
            </Field>
            <div className={styles.full}>
              <Button type="submit" tone="primary" size="sm" disabled={paying}>
                {t("checkCashing.badPay")}
              </Button>
            </div>
          </form>
        )}
      </div>
    );
  }

  return (
    <>
      <Modal
        open={id != null && !writingOff} onClose={close} size="lg"
        title={bad ? t("checkCashing.badCheckTitle", { name: bad.customer_name }) : t("checkCashing.badCheckPill")}
        actions={(
          <>
            {data?.can_write_off && (
              <Button
                type="button" tone="danger"
                onClick={() => { setOffNote(""); setOffError(null); setWritingOff(true); }}
              >
                {t("checkCashing.badWriteOff")}
              </Button>
            )}
            <Button type="button" tone="secondary" onClick={close}>
              {t("common.close")}
            </Button>
          </>
        )}
      >
        {body}
      </Modal>
      <ConfirmDialog
        open={writingOff && bad != null}
        title={t("checkCashing.badWriteOffTitle")}
        message={bad ? (
          <>
            <p className={styles.note}>
              {t("checkCashing.badWriteOffMessage", {
                amount: fmtMoney2(bad.balance), name: bad.customer_name,
              })}
            </p>
            <Field label={t("checkCashing.badWriteOffNote")}>
              <Input
                type="text" maxLength={255} autoFocus
                value={offNote} onChange={(e) => setOffNote(e.target.value)}
              />
            </Field>
          </>
        ) : ""}
        confirmLabel={t("checkCashing.badWriteOff")}
        confirmTone="danger"
        busy={offBusy}
        error={offError}
        onConfirm={() => void writeOff()}
        onCancel={() => { setWritingOff(false); setOffError(null); }}
      />
    </>
  );
}
