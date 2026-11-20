import { useMemo, useRef, useState } from "react";

import {
  checkModisoftDepartments,
  importDepartments,
  type DepartmentImportCheck,
  type DepartmentImportCheckRow,
  type DepartmentType,
} from "../api/dayclose";
import { apiErrorMessage } from "../lib/api";
import { ratePercentText } from "../lib/departmentTypes";
import { fmtNumber } from "../lib/formatters";
import {
  Alert, Button, Checkbox, KpiCard, KpiGrid, Modal, ModalActions, Pill,
  Select, Table, useToast,
} from "./ui";
import { DepartmentTypeOptions } from "./DepartmentTypeOptions";
import styles from "./DepartmentImportModal.module.css";
import { t, tn, useT, type MessageKey, type PluralBase } from "../i18n";

// Account → Departments → "Import from Modisoft" (owner, 2026-11-19).
// The person picks Modisoft's departments export; the server CHECKS it
// (nothing written) and plans each row. Modisoft has five types and
// DineroBook splits Lottery and Services by the daily book line their
// sales land on, so those rows come with a guess from the name and are
// marked: the person confirms the type here, inside the import, and
// only then does anything save. Rules: api/Modules/DayClose/Services/
// modisoft_departments.py.

const EDIT_PERM = "day_close.update";

const ISSUE_TEXT: Record<string, PluralBase> = {
  no_name: "deptImport.issue.no_name",
  bad_number: "deptImport.issue.bad_number",
  bad_pos: "deptImport.issue.bad_pos",
  bad_nacs: "deptImport.issue.bad_nacs",
};

const CHANGE_TEXT: Record<string, MessageKey> = {
  name: "deptImport.change.name",
  type: "deptImport.change.type",
  tax: "deptImport.change.tax",
  age: "deptImport.change.age",
  nacs: "deptImport.change.nacs",
  pos: "deptImport.change.pos",
};

// Rows whose Modisoft type covers several DineroBook types.
const NARROWED = new Set(["lottery", "services"]);

interface Choice {
  include: boolean;
  type: DepartmentType;
}

export function DepartmentImportModal({
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
  const [report, setReport] = useState<DepartmentImportCheck | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [onlyToCheck, setOnlyToCheck] = useState(false);
  const [busy, setBusy] = useState<"" | "check" | "import">("");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function reset() {
    setFile(null); setReport(null); setChoices({}); setOnlyToCheck(false);
    setBusy(""); setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function check(next: File) {
    setFile(next); setReport(null); setChoices({}); setError(null); setBusy("check");
    try {
      const r = await checkModisoftDepartments(next);
      setReport(r);
      setChoices(Object.fromEntries(r.rows.map((row) => [
        row.line, { include: row.include, type: row.department_type },
      ])));
    } catch (err) {
      setError(apiErrorMessage(err, t("deptImport.readFailed"), { anyError: true }));
    } finally {
      setBusy("");
    }
  }

  const picked = useMemo(
    () => (report?.rows ?? []).filter((r) => choices[r.line]?.include),
    [report, choices],
  );
  const toCheck = picked.filter((r) => !r.type_sure);

  async function runImport() {
    if (!picked.length || busy) return;
    setError(null); setBusy("import");
    try {
      const done = await importDepartments(picked.map((r) => ({
        name: r.name,
        pos_code: r.pos_code,
        department_type: choices[r.line].type,
        is_taxable: r.is_taxable,
        tax_rate: r.tax_rate,
        min_age: r.min_age,
        nacs_code: r.nacs_code,
      })));
      toast({
        message: t("deptImport.done", {
          new: fmtNumber(done.created), updated: fmtNumber(done.updated),
        }),
        tone: "success",
      });
      reset();
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t("deptImport.failed"), { anyError: true }));
    } finally {
      setBusy("");
    }
  }

  function setChoice(line: number, next: Partial<Choice>) {
    setChoices((c) => ({ ...c, [line]: { ...c[line], ...next } }));
  }

  const shown = (report?.rows ?? []).filter(
    (r) => !onlyToCheck || (!r.type_sure && choices[r.line]?.include),
  );

  return (
    <Modal
      open={open}
      size="xl"
      disabled={busy !== ""}
      title={t("deptImport.title")}
      onClose={() => { reset(); onClose(); }}
    >
      <div className={styles.pane}>
        <p className={styles.lead}>{t("deptImport.lead")}</p>
        <div className={styles.uploadRow}>
          <input
            ref={fileRef}
            type="file"
            accept=".xls,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            aria-label={t("deptImport.fileAria")}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void check(f);
            }}
          />
          <Button
            type="button" tone={report ? "secondary" : "primary"}
            busy={busy === "check"} disabled={busy !== ""}
            onClick={() => fileRef.current?.click()}
          >
            {file ? t("deptImport.chooseAnother") : t("deptImport.choose")}
          </Button>
          {file && <span className={styles.fileName}>{file.name}</span>}
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        {report && (
          <ReviewSummary
            report={report} picked={picked} toCheck={toCheck.length}
            choices={choices}
          />
        )}
        {report && toCheck.length > 0 && (
          <Checkbox checked={onlyToCheck} onChange={setOnlyToCheck}>
            {tn("deptImport.onlyToCheck", toCheck.length, fmtNumber)}
          </Checkbox>
        )}
        {report && report.rows.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th className={styles.tick}><span className={styles.srOnly}>{t("deptImport.colImport")}</span></th>
                <th>{t("dept.colPos")}</th>
                <th>{t("dept.colDepartment")}</th>
                <th>{t("deptImport.colModisoftType")}</th>
                <th>{t("dept.colType")}</th>
                <th>{t("dept.colTax")}</th>
                <th>{t("dept.colAge")}</th>
                <th>{t("common.status")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <ReviewRow
                  key={row.line}
                  row={row}
                  choice={choices[row.line]}
                  disabled={busy !== ""}
                  onChange={(next) => setChoice(row.line, next)}
                />
              ))}
            </tbody>
          </Table>
        )}
      </div>
      <ModalActions>
        <Button
          tone="secondary" type="button" disabled={busy === "import"}
          onClick={() => { reset(); onClose(); }}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="button" perm={EDIT_PERM}
          busy={busy === "import"}
          disabled={busy !== "" || picked.length === 0}
          onClick={() => { void runImport(); }}
        >
          {picked.length > 0
            ? tn("deptImport.button", picked.length, fmtNumber)
            : t("deptImport.nothing")}
        </Button>
      </ModalActions>
    </Modal>
  );
}

/** "New", "Update" or "Up to date" for a row, counting a type the
 *  person changed. */
function rowStatus(row: DepartmentImportCheckRow, type: DepartmentType) {
  if (row.status === "new" || row.status === "skip") {
    return { status: row.status, changes: row.changes };
  }
  const others = row.changes.filter((c) => c !== "type");
  const changes = row.existing_type !== type ? [...others, "type" as const] : others;
  return { status: changes.length ? "update" : "same", changes };
}

function ReviewSummary({
  report, picked, toCheck, choices,
}: {
  report: DepartmentImportCheck;
  picked: DepartmentImportCheckRow[];
  toCheck: number;
  choices: Record<number, Choice>;
}) {
  useT(); // re-render on a language switch
  const statuses = picked.map((r) => rowStatus(r, choices[r.line].type).status);
  const count = (s: string) => statuses.filter((x) => x === s).length;
  const unused = report.rows.filter((r) => r.unused && !choices[r.line]?.include).length;
  return (
    <div className={styles.report}>
      <p className={styles.sub}>{tn("deptImport.rows", report.rows.length, fmtNumber)}</p>
      <KpiGrid>
        <KpiCard label={t("deptImport.new")} tone="neon" value={fmtNumber(count("new"))} />
        <KpiCard
          label={t("deptImport.updated")} value={fmtNumber(count("update"))}
          sub={tn("deptImport.same", count("same"), fmtNumber)}
        />
        <KpiCard label={t("deptImport.typeToCheck")} value={fmtNumber(toCheck)} />
      </KpiGrid>
      {toCheck > 0 && <Alert tone="warning">{t("deptImport.checkTypes")}</Alert>}
      <ul className={styles.notes}>
        {unused > 0 && <li>{tn("deptImport.unused", unused, fmtNumber)}</li>}
        {report.columns_ignored.length > 0 && (
          <li>{t("deptImport.ignored", { columns: report.columns_ignored.join(", ") })}</li>
        )}
        {report.issues.map((issue) => {
          const base = ISSUE_TEXT[issue.code];
          if (!base) return null;
          const lines = issue.lines.map((l) => fmtNumber(l)).join(", ");
          return (
            <li key={issue.code}>
              {tn(base, issue.count, fmtNumber)}{" "}
              <span className={styles.lines}>
                {tn("deptImport.lines", issue.lines.length, String, { lines })}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ReviewRow({
  row, choice, disabled, onChange,
}: {
  row: DepartmentImportCheckRow;
  choice: Choice;
  disabled: boolean;
  onChange: (next: Partial<Choice>) => void;
}) {
  useT(); // re-render on a language switch
  const skip = row.status === "skip";
  const needsLook = !row.type_sure && choice.include;
  const { status, changes } = rowStatus(row, choice.type);
  const group = NARROWED.has(row.type_group)
    ? (row.type_group as "lottery" | "services") : undefined;
  return (
    <tr className={needsLook ? styles.needsLook : skip ? styles.skipped : undefined}>
      <td className={styles.tick}>
        <Checkbox
          checked={choice.include}
          disabled={disabled || skip}
          aria-label={t("deptImport.includeAria", { name: row.name })}
          onChange={(include) => onChange({ include })}
        />
      </td>
      <td className={styles.code}>{row.pos_code ?? <span className={styles.muted}>—</span>}</td>
      <td>
        <span className={styles.nameCell}>
          <span>{row.name}</span>
          {row.unused && <span className={styles.muted}>{t("deptImport.unusedRow")}</span>}
        </span>
      </td>
      <td>{row.modisoft_type || <span className={styles.muted}>—</span>}</td>
      <td>
        <Select
          className={styles.typePick}
          aria-label={t("deptImport.typeAria", { name: row.name })}
          value={choice.type}
          disabled={disabled || skip}
          onChange={(e) => onChange({ type: e.target.value as DepartmentType })}
        >
          <DepartmentTypeOptions group={group} />
        </Select>
        {needsLook && <span className={styles.lookHint}>{t("deptImport.checkThis")}</span>}
      </td>
      <td><TaxText row={row} /></td>
      <td>
        {row.min_age
          ? t("dept.agePlus", { age: String(row.min_age) })
          : <span className={styles.muted}>—</span>}
      </td>
      <td><StatusCell row={row} status={status} changes={changes} /></td>
    </tr>
  );
}

function TaxText({ row }: { row: DepartmentImportCheckRow }) {
  useT(); // re-render on a language switch
  if (row.is_taxable == null) return <span className={styles.muted}>—</span>;
  if (!row.is_taxable) return <>{t("dept.nonTaxable")}</>;
  return (
    <>
      {row.tax_rate != null
        ? t("dept.taxableAt", { rate: ratePercentText(row.tax_rate) })
        : t("dept.taxable")}
    </>
  );
}

function StatusCell({
  row, status, changes,
}: {
  row: DepartmentImportCheckRow;
  status: string;
  changes: string[];
}) {
  useT(); // re-render on a language switch
  if (status === "skip") {
    const text = {
      duplicate_name: t("deptImport.problem.duplicate_name"),
      duplicate_pos: t("deptImport.problem.duplicate_pos", { code: row.pos_code ?? "" }),
      pos_taken: t("deptImport.problem.pos_taken", {
        code: row.pos_code ?? "", name: row.problem_name,
      }),
      name_taken: t("deptImport.problem.name_taken", { name: row.problem_name }),
    }[row.problem ?? "duplicate_name"];
    return (
      <span className={styles.statusCell}>
        <Pill tone="negative">{t("deptImport.status.skip")}</Pill>
        <span className={styles.muted}>{text}</span>
      </span>
    );
  }
  if (status === "new") return <Pill tone="accent">{t("deptImport.status.new")}</Pill>;
  if (status === "same") return <Pill>{t("deptImport.status.same")}</Pill>;
  return (
    <span className={styles.statusCell}>
      <Pill tone="warning">{t("deptImport.status.update")}</Pill>
      <span className={styles.muted}>
        {[
          row.existing_name !== row.name ? t("deptImport.was", { name: row.existing_name }) : "",
          changes.map((c) => t(CHANGE_TEXT[c])).join(", "),
        ].filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}

