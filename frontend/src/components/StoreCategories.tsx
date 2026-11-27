import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  createPLCategory, renamePLCategory, setPLCategoryArchived,
  usePLCategories, type PLCategoryRow,
} from "../api/monthly";
import { apiErrorMessage } from "../lib/api";
import { fmtNumber } from "../lib/formatters";
import {
  Alert, Button, Card, ConfirmDialog, Empty, ErrorState, Field, Input,
  Loading, Modal, ModalActions, Pill, RowActions, Select, Table,
  tdStyle, tdStyleRight, thStyle, thStyleRight, useToast,
} from "./ui";
import { t, tn, useT } from "../i18n";
import styles from "./StoreCategories.module.css";

// "Your own categories" on P&L categories (owner 2026-11-27:
// unlimited). Each one is a bank category the store tags rows into,
// counted in its half of the P&L. Only with `pl_transactions`; the
// section is not shown at all without it.
//
// Every action saves at once (add / rename in a popup, archive with
// a confirm), so there is no page-level Save and nothing to guard.

type Section = PLCategoryRow["section"];

export function StoreCategories() {
  useT();
  const qc = useQueryClient();
  const toast = useToast();
  const cats = usePLCategories();
  // null: closed; "new": adding; a row: renaming it.
  const [editing, setEditing] = useState<PLCategoryRow | "new" | null>(null);
  const [archiving, setArchiving] = useState<PLCategoryRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (cats.isLoading) return <Loading />;
  if (cats.isError) {
    return (
      <ErrorState
        message={apiErrorMessage(cats.error, t("storeCat.loadFailed"))}
        onRetry={() => { void cats.refetch(); }}
      />
    );
  }
  if (!cats.data?.enabled) return null;
  const rows = cats.data.rows;

  function refresh() {
    // The bank picker, the statement and every month read these.
    void qc.invalidateQueries({ queryKey: ["monthly"] });
    void qc.invalidateQueries({ queryKey: ["bank"] });
  }

  async function onArchive(row: PLCategoryRow, archived: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await setPLCategoryArchived(row.id, archived);
      toast({
        message: t(archived ? "storeCat.archived" : "storeCat.restored", { name: row.name }),
        tone: "success",
      });
      setArchiving(null);
      refresh();
    } catch (e) {
      setArchiving(null);
      setErr(apiErrorMessage(e, t("storeCat.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>{t("storeCat.title")}</h2>
          <p className={styles.intro}>{t("storeCat.intro")}</p>
        </div>
        <Button
          tone="primary" perm="monthly.update"
          onClick={() => { setErr(null); setEditing("new"); }}
        >
          {t("storeCat.add")}
        </Button>
      </div>

      {err && <Alert tone="error">{err}</Alert>}

      {rows.length === 0 ? (
        <Empty>{t("storeCat.none")}</Empty>
      ) : (
        <div className={styles.tableWrap}>
          <Table>
            <thead>
              <tr>
                <th style={thStyle}>{t("storeCat.colName")}</th>
                <th style={thStyle}>{t("storeCat.colSection")}</th>
                <th style={thStyleRight}>{t("storeCat.colUsed")}</th>
                <th style={thStyle} aria-label={t("common.actions")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={tdStyle}>
                    <span className={styles.name}>{r.name}</span>
                    {r.archived && <Pill tone="neutral">{t("storeCat.archivedPill")}</Pill>}
                  </td>
                  <td style={tdStyle}>{t(r.section === "income" ? "storeCat.income" : "storeCat.expense")}</td>
                  <td style={tdStyleRight}>{tn("storeCat.rows", r.in_use, fmtNumber)}</td>
                  <td style={tdStyle}>
                    <RowActions
                      actions={[
                        {
                          label: t("storeCat.rename"), perm: "monthly.update",
                          onClick: () => { setErr(null); setEditing(r); },
                        },
                        r.archived ? {
                          label: t("storeCat.restore"), perm: "monthly.update",
                          busy, onClick: () => onArchive(r, false),
                        } : {
                          label: t("storeCat.archive"), perm: "monthly.update",
                          tone: "danger", onClick: () => setArchiving(r),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      {editing && (
        <CategoryForm
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(name, created) => {
            setEditing(null);
            toast({
              message: t(created ? "storeCat.added" : "storeCat.renamed", { name }),
              tone: "success",
            });
            refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={archiving != null}
        title={t("storeCat.archiveTitle", { name: archiving?.name ?? "" })}
        message={t("storeCat.archiveBody")}
        confirmLabel={t("storeCat.archive")}
        confirmTone="danger"
        busy={busy}
        onConfirm={() => { if (archiving) void onArchive(archiving, true); }}
        onCancel={() => setArchiving(null)}
      />
    </Card>
  );
}

/** Add (row null) or rename one category, in a popup. The section
 *  is chosen once: moving money between halves would rewrite every
 *  closed month it counted in. */
function CategoryForm({
  row, onClose, onSaved,
}: {
  row: PLCategoryRow | null;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [section, setSection] = useState<Section>(row?.section ?? "expense");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = row
        ? await renamePLCategory(row.id, name)
        : await createPLCategory(name, section);
      onSaved(res.category.name, row == null);
    } catch (e2) {
      setErr(apiErrorMessage(e2, t("storeCat.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={onClose} disabled={busy}
      title={row ? t("storeCat.renameTitle") : t("storeCat.addTitle")}
    >
      <form onSubmit={onSubmit} className="ds-form">
        {err && <Alert tone="error">{err}</Alert>}
        <Field label={t("storeCat.colName")} required>
          <Input
            value={name} maxLength={60} autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {!row && (
          <Field label={t("storeCat.colSection")} hint={t("storeCat.sectionHint")}>
            <Select value={section} onChange={(e) => setSection(e.target.value as Section)}>
              <option value="expense">{t("storeCat.expense")}</option>
              <option value="income">{t("storeCat.income")}</option>
            </Select>
          </Field>
        )}
        <ModalActions>
          <Button type="button" tone="secondary" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" tone="primary" disabled={busy || name.trim() === ""}>
            {busy ? t("common.saving") : row ? t("storeCat.saveName") : t("storeCat.add")}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
