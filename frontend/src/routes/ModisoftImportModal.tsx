import { useRef, useState } from "react";

import {
  importModisoftPriceBook,
  type ImportIssue,
  type ModisoftImportReport,
} from "../api/catalog";
import {
  Alert, Button, Checkbox, KpiCard, KpiGrid, Modal, ModalActions, useToast,
} from "../components/ui";
import { apiErrorMessage } from "../lib/api";
import { fmtNumber } from "../lib/formatters";
import { t, tn, useT, type PluralBase } from "../i18n";
import styles from "./ModisoftImportModal.module.css";

// Price book → "Import from Modisoft". The person picks the .xlsx that
// Modisoft's price book exports; the server CHECKS it first (nothing
// written) and the report shows what would happen. Import sends the
// same file again with apply=true. Rules (matching, "an empty or zero
// cell never overwrites", departments by name) live in
// api/Modules/Catalog/Services/modisoft_import.py.

const ISSUE_TEXT: Record<string, PluralBase> = {
  invalid_code: "pb.importIssue.invalid_code",
  duplicate_code: "pb.importIssue.duplicate_code",
  no_name: "pb.importIssue.no_name",
  bad_number: "pb.importIssue.bad_number",
  negative_number: "pb.importIssue.negative_number",
  numeric_code: "pb.importIssue.numeric_code",
};
const DEPARTMENTS_SHOWN = 12;

export function ModisoftImportModal({
  open, onClose, onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a successful import (the list re-fetches). */
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [updateExisting, setUpdateExisting] = useState(true);
  const [report, setReport] = useState<ModisoftImportReport | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "import">("");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function reset() {
    setFile(null); setReport(null); setBusy(""); setError(null);
    setUpdateExisting(true);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function check(next: File, update: boolean) {
    setFile(next); setReport(null); setError(null); setBusy("check");
    try {
      setReport(await importModisoftPriceBook(next, {
        apply: false, updateExisting: update,
      }));
    } catch (err) {
      setError(apiErrorMessage(err, t("pb.importReadFailed"), { anyError: true }));
    } finally {
      setBusy("");
    }
  }

  async function runImport() {
    if (!file || busy) return;
    setError(null); setBusy("import");
    try {
      const done = await importModisoftPriceBook(file, {
        apply: true, updateExisting,
      });
      toast({
        message: t("pb.imported", {
          new: fmtNumber(done.items_new),
          updated: fmtNumber(done.items_updated),
        }),
        tone: "success",
      });
      reset();
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t("pb.importFailed"), { anyError: true }));
    } finally {
      setBusy("");
    }
  }

  const toWrite = report ? report.items_new + report.items_updated : 0;

  return (
    <Modal
      open={open}
      size="lg"
      disabled={busy !== ""}
      title={t("pb.importTitle")}
      onClose={() => { reset(); onClose(); }}
    >
      <div className={styles.pane}>
        <p className={styles.lead}>{t("pb.importLead")}</p>
        <div className={styles.uploadRow}>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label={t("pb.importFileAria")}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void check(f, updateExisting);
            }}
          />
          <Button
            type="button" tone={report ? "secondary" : "primary"}
            busy={busy === "check"} disabled={busy !== ""}
            onClick={() => fileRef.current?.click()}
          >
            {file ? t("pb.importAnother") : t("pb.importChoose")}
          </Button>
          {file && <span className={styles.fileName}>{file.name}</span>}
        </div>
        <div>
          <Checkbox
            checked={updateExisting}
            disabled={busy !== ""}
            onChange={(next) => {
              setUpdateExisting(next);
              if (file) void check(file, next);
            }}
          >
            {t("pb.importUpdateExisting")}
          </Checkbox>
          <p className={styles.hint}>{t("pb.importUpdateHint")}</p>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        {report && <ImportReportView report={report} />}
      </div>
      <ModalActions>
        <Button
          tone="secondary" type="button" disabled={busy === "import"}
          onClick={() => { reset(); onClose(); }}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="button" perm="catalog.update"
          busy={busy === "import"}
          disabled={busy !== "" || report == null || toWrite === 0}
          onClick={() => { void runImport(); }}
        >
          {report != null && toWrite > 0
            ? tn("pb.importButton", toWrite, fmtNumber)
            : t("pb.importNothing")}
        </Button>
      </ModalActions>
    </Modal>
  );
}

function ImportReportView({ report }: { report: ModisoftImportReport }) {
  useT(); // re-render on a language switch
  const depts = report.departments_new;
  const extra = depts.length - DEPARTMENTS_SHOWN;
  return (
    <div className={styles.report}>
      <p className={styles.sub}>
        {tn("pb.importRows", report.rows_read, fmtNumber)}
      </p>
      <KpiGrid>
        <KpiCard
          label={t("pb.importNew")} tone="neon"
          value={fmtNumber(report.items_new)}
        />
        <KpiCard
          label={t("pb.importUpdated")}
          value={fmtNumber(report.items_updated)}
          sub={
            report.items_skipped > 0
              ? tn("pb.importSkipped", report.items_skipped, fmtNumber)
              : tn("pb.importUnchanged", report.items_unchanged, fmtNumber)
          }
        />
        <KpiCard
          label={t("pb.importDepartments")}
          value={fmtNumber(depts.length)}
        />
      </KpiGrid>
      {depts.length > 0 && (
        <p className={styles.sub}>
          {t("pb.importDepartmentList", {
            names: depts.slice(0, DEPARTMENTS_SHOWN).join(", "),
          })}
          {extra > 0 && ` ${t("pb.more", { count: fmtNumber(extra) })}`}
        </p>
      )}
      <ul className={styles.notes}>
        {report.matched_other_spelling > 0 && (
          <li>{tn("pb.importOtherSpelling", report.matched_other_spelling, fmtNumber)}</li>
        )}
        {report.products_known > 0 && (
          <li>{tn("pb.importShared", report.products_known, fmtNumber)}</li>
        )}
        {report.store_codes > 0 && (
          <li>{tn("pb.importStoreCodes", report.store_codes, fmtNumber)}</li>
        )}
        {report.columns_ignored.length > 0 && (
          <li>
            {t("pb.importIgnored", { columns: report.columns_ignored.join(", ") })}
          </li>
        )}
      </ul>
      {report.issues.length > 0 && (
        <Alert tone="warning">
          <ul className={styles.issues}>
            {report.issues.map((issue) => (
              <IssueLine key={issue.code} issue={issue} />
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}

function IssueLine({ issue }: { issue: ImportIssue }) {
  useT(); // re-render on a language switch
  const base = ISSUE_TEXT[issue.code];
  if (!base) return null;
  const lines = issue.examples.map((e) => fmtNumber(e.line)).join(", ");
  return (
    <li>
      {tn(base, issue.count, fmtNumber)}
      {lines && (
        <span className={styles.lines}>
          {" "}{tn("pb.importLines", issue.examples.length, String, { lines })}
        </span>
      )}
    </li>
  );
}
