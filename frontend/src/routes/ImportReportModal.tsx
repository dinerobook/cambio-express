import { useState } from "react";

import { Alert, Button, Loading, Modal, Pill } from "../components/ui";
import { apiErrorMessage } from "../lib/api";
import { fmtMoney2 } from "../lib/formatters";
import {
  commitIntermexReport,
  parseIntermexReport,
  type IntermexCommit,
  type IntermexReport,
} from "../api/reportImport";
import styles from "./ImportReportModal.module.css";
import { t, tn, tNodes, useT } from "../i18n";

// Daily-book "Import Intermex report" flow.  Upload the company's
// "Reporte de cierre del día" PDF → the backend parses it IN MEMORY
// (nothing stored) → we show the extracted rows for review → Commit
// aggregates the settled giros into the day's money-transfer breakdown
// (the Intermex company row) and reports how it reconciles against the
// transfers already logged.  The PDF is re-parsed server-side on
// commit — the client never sends money numbers.

/** The Intermex PDF's own title. Intermex prints it in Spanish, so
 *  it is quoted as printed in both languages. */
const REPORT_NAME = "“Reporte de cierre del día”";

export function ImportReportModal({
  open, onClose, storeId, reportDate, onCommitted,
}: {
  open: boolean;
  onClose: () => void;
  /** Store whose daily book is being edited. */
  storeId: number;
  /** The day being edited (YYYY-MM-DD) — used to warn if the report's
   *  own date doesn't match, and the day the giros commit to. */
  reportDate: string;
  /** Called after a successful commit so the editor re-fetches the
   *  daily report (its money-transfer total changed). */
  onCommitted?: () => void;
}) {
  useT(); // re-render on a language switch
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<IntermexReport | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<IntermexCommit | null>(null);

  function reset() {
    setResult(null); setErr(null); setBusy(false); setFileName("");
    setFile(null); setCommitting(false); setCommitted(null);
  }

  async function handleFile(f: File) {
    setErr(null); setResult(null); setCommitted(null); setBusy(true);
    setFileName(f.name); setFile(f);
    try {
      setResult(await parseIntermexReport(f));
    } catch (e) {
      setErr(apiErrorMessage(e, t("intermex.readFailed"), { anyError: true }));
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (!file || committing) return;
    setErr(null); setCommitting(true);
    try {
      const res = await commitIntermexReport(file, storeId, reportDate);
      setCommitted(res);
      onCommitted?.();
    } catch (e) {
      setErr(apiErrorMessage(e, t("intermex.readFailed"), { anyError: true }));
    } finally {
      setCommitting(false);
    }
  }

  const dateMismatch =
    result?.report_date != null && result.report_date !== reportDate;

  return (
    <Modal
      open={open}
      title={t("intermex.title")}
      size="lg"
      disabled={busy}
      onClose={() => { reset(); onClose(); }}
    >
      {!result && (
        <div className={styles.uploadPane}>
          <p className={styles.lead}>
            {tNodes("intermex.lead", {
              // The PDF's own title, in Spanish in both languages.
              name: <em>{REPORT_NAME}</em>,
            })}
          </p>
          <label className={styles.fileLabel}>
            <input
              type="file"
              accept="application/pdf,.pdf"
              aria-label={t("intermex.fileAria")}
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
          </label>
          {busy && <Loading />}
          {err && <Alert tone="error">{err}</Alert>}
        </div>
      )}

      {result && (
        <div className={styles.result}>
          <div className={styles.summaryRow}>
            <div>
              <div className={styles.agency}>{result.agency}</div>
              <div className={styles.sub}>
                {tNodes("intermex.reportDate", {
                  file: fileName,
                  date: <strong>{result.report_date ?? "—"}</strong>,
                })}
              </div>
            </div>
            <Pill tone={result.all_reconcile ? "success" : "warning"} dot>
              {result.all_reconcile
                ? t("intermex.allReconcile")
                : t("intermex.review")}
            </Pill>
          </div>

          {dateMismatch && (
            <Alert tone="warning">
              {tNodes("intermex.dateMismatch", {
                reportDate: <strong>{result.report_date}</strong>,
                editing: <strong>{reportDate}</strong>,
              })}
            </Alert>
          )}

          <div className={styles.sectionTitle}>
            {t("intermex.moneyTransfers", { count: result.giros.length })}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t("intermex.colTransfer")}</th>
                  <th className={styles.num}>{t("intermex.colSend")}</th>
                  <th className={styles.num}>{t("intermex.colFee")}</th>
                  <th className={styles.num}>{t("intermex.colTax")}</th>
                  <th className={styles.num}>{t("intermex.colTotal")}</th>
                  <th>{t("intermex.colCashier")}</th>
                  <th>{t("intermex.colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {result.giros.map((g) => (
                  <tr key={g.confirm_number}
                      className={g.cancelled ? styles.cancelled : undefined}>
                    <td className={styles.mono}>{g.confirm_number}</td>
                    <td className={`${styles.num} ${styles.mono}`}>{fmtMoney2(g.send_amount)}</td>
                    <td className={`${styles.num} ${styles.mono}`}>{fmtMoney2(g.fee)}</td>
                    <td className={`${styles.num} ${styles.mono}`}>{fmtMoney2(g.federal_tax)}</td>
                    <td className={`${styles.num} ${styles.mono}`}>{fmtMoney2(g.total_collected)}</td>
                    <td>{g.cashier || "—"}</td>
                    <td>
                      <GiroStatus giro={g} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.otherCounts}>
            {t("intermex.alsoInReport", {
              moneyOrders: tn("intermex.moneyOrders", result.money_orders.length),
              billPayments: tn("intermex.billPayments", result.bill_payments.length),
            })}
            <span className={styles.soon}>{t("intermex.wiredNext")}</span>
          </div>

          {committed && (
            <Alert tone={committed.matches_logged ? "success" : "warning"}>
              {tNodes(
                committed.giros_committed === 1
                  ? "intermex.committed.one" : "intermex.committed.other",
                {
                  count: committed.giros_committed,
                  date: reportDate,
                  fees: fmtMoney2(committed.fees),
                  tax: fmtMoney2(committed.federal_tax),
                  company: <strong>{committed.company}</strong>,
                  amount: <strong>{fmtMoney2(committed.amount)}</strong>,
                },
              )}
              {committed.matches_logged
                ? t("intermex.matchesLogged")
                : t("intermex.headsUp", {
                  amount: fmtMoney2(committed.logged_amount),
                })}
            </Alert>
          )}

          {err && <Alert tone="error">{err}</Alert>}

          <div className={styles.actions}>
            <Button tone="secondary" onClick={reset} disabled={committing}>
              {t("intermex.importAnother")}
            </Button>
            {committed ? (
              <Button
                tone="primary"
                onClick={() => { reset(); onClose(); }}
              >
                {t("intermex.done")}
              </Button>
            ) : (
              <Button
                tone="primary"
                busy={committing}
                disabled={committing || !result.all_reconcile}
                title={result.all_reconcile
                  ? undefined
                  : t("intermex.mustReconcile")}
                onClick={() => void handleCommit()}
              >
                {committing ? t("intermex.committing") : t("intermex.commit")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** One giro's state: cancelled, a replacement, reconciled, or to check. */
function GiroStatus({ giro }: { giro: IntermexReport["giros"][number] }) {
  const t = useT();
  if (giro.cancelled) return <Pill tone="negative">{t("intermex.cancelled")}</Pill>;
  if (giro.replacement) return <Pill tone="info">{t("intermex.replacement")}</Pill>;
  if (giro.reconciles) return <Pill tone="success">{t("intermex.ok")}</Pill>;
  return <Pill tone="warning">{t("intermex.check")}</Pill>;
}
