import { useMemo, useState } from "react";

import {
  applyRule,
  categoryLabels,
  deleteRule,
  reorderRules,
  toggleRule,
  useBankCategories,
  useBankRules,
  useRuleTemplates,
  type BankRuleRow,
  type BankRuleTemplateRow,
} from "../api/bankSync";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { canDo } from "../lib/access";
import { BankRuleForm } from "../components/BankRuleForm";
import { BankRuleSentence } from "../components/BankRuleSentence";
import { BankRuleTemplateList } from "../components/BankRuleTemplateList";
import {
  describeAppliedRule, formValuesFromRule, formValuesFromTemplate,
  ruleSentence,
} from "../lib/bankRules";
import {
  Button, ButtonLink, Card, ConfirmDialog, EmptyState,
  ErrorState, IconButton, Input, Loading, Modal, PageHeader, PageShell,
  RowActions, useToast,
} from "../components/ui";
import styles from "./BankRules.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { tn, useT } from "../i18n";
import { navWord } from "../i18n/navWords";
import { fmtNumber } from "../lib/formatters";

// /app/bank/rules — the store's bank rules, Monarch-style: every
// rule reads as a sentence ("If description contains X and money
// out → Categorize as Check deposit, book it"), the list IS the
// evaluation order (first match wins), and the operator moves a
// rule up or down to change it. Create / edit happen in a modal
// built on the shared BankRuleForm, the same form the bank
// transactions page opens from a row. Below the list, the rule
// templates the platform ships ("Intermex commission deposit"…):
// "Use" opens the same form prefilled, so the store saves its own
// copy and can add its account first.

export default function BankRules() {
  const rules = useBankRules();
  const templates = useRuleTemplates();
  const categories = useBankCategories();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const t = useT();
  const labels = useMemo(() => categoryLabels(categories.data?.groups), [categories.data]);

  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<
    BankRuleRow | "new" | { template: BankRuleTemplateRow } | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<BankRuleRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const rows = rules.data?.rows ?? [];
  const templateRows = templates.data?.rows ?? [];
  const shown = q.trim()
    ? rows.filter((r) => ruleSentence(r, labels).toLowerCase().includes(q.trim().toLowerCase()))
    : rows;
  const canReorder = canDo("bank_sync.update") && !q.trim();

  async function handleToggle(r: BankRuleRow) {
    setBusyId(r.id);
    try {
      await toggleRule(r.id, !r.enabled);
      await rules.refetch();
      toast({ message: r.enabled ? t("rules.disabled") : t("rules.enabledToast"), tone: "success" });
    } catch (e) {
      toastApiError(e, t("rules.updateFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleApply(r: BankRuleRow) {
    setBusyId(r.id);
    try {
      const resp = await applyRule(r.id);
      await rules.refetch();
      toast({ message: `${t("rules.applied")}${describeAppliedRule(resp.applied)}`, tone: "success" });
    } catch (e) {
      toastApiError(e, t("rules.applyFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function move(r: BankRuleRow, delta: -1 | 1) {
    const idx = rows.findIndex((x) => x.id === r.id);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= rows.length) return;
    const ids = rows.map((x) => x.id);
    [ids[idx], ids[to]] = [ids[to], ids[idx]];
    setBusyId(r.id);
    try {
      await reorderRules(ids);
      await rules.refetch();
    } catch (e) {
      toastApiError(e, t("rules.reorderFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function doDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      await deleteRule(pendingDelete.id);
      await rules.refetch();
      setPendingDelete(null);
      toast({ message: t("rules.deleted"), tone: "success" });
    } catch (e) {
      // Keep the prompt open so the operator can retry or cancel; a
      // bare rejection here used to vanish as an unhandled promise.
      toastApiError(e, t("rules.deleteFailed"));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />

      <PageHeader
        title={navWord("Bank rules")}
        subtitle={t("rules.subtitle")}
        actions={
          <div className={styles.headerActions}>
            <ButtonLink to="/bank-transactions" tone="secondary">
              {navWord("Bank transactions")}
            </ButtonLink>
            <ButtonLink to="/monthly/categories" tone="secondary">
              {t("rules.plCategories")}
            </ButtonLink>
            <Button perm="bank_sync.create" onClick={() => setEditing("new")}>
              {t("rules.newRule")}
            </Button>
          </div>
        }
      />

      <Card>
        <div className={styles.toolbar}>
          <span className={styles.count}>
            {tn("rules.count", rows.length, fmtNumber)}
          </span>
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("rules.searchPh")}
            aria-label={t("rules.searchAria")}
            className={styles.search}
          />
        </div>

        {rules.isLoading && <Loading />}
        {rules.isError && (
          <ErrorState
            message={t("rules.loadFailed")}
            onRetry={() => { void rules.refetch(); }}
          />
        )}
        {!rules.isLoading && !rules.isError && rows.length === 0 && (
          <EmptyState
            title={t("rules.emptyTitle")}
            body={t("rules.emptyBody")}
          />
        )}
        {!rules.isLoading && rows.length > 0 && shown.length === 0 && (
          <EmptyState title={t("rules.noMatch")} />
        )}

        {shown.length > 0 && (
          <ol className={styles.list}>
            {shown.map((r, i) => (
              <li
                key={r.id}
                className={[styles.rule, r.enabled ? "" : styles.ruleDisabled].join(" ")}
              >
                <div className={styles.order}>
                  {canReorder ? (
                    <>
                      <IconButton
                        size="sm" tone="ghost" title={t("rules.moveUp")}
                        disabled={i === 0 || busyId != null}
                        onClick={() => { void move(r, -1); }}
                      >
                        <ArrowIcon dir="up" />
                      </IconButton>
                      <span className={styles.orderNum}>{i + 1}</span>
                      <IconButton
                        size="sm" tone="ghost" title={t("rules.moveDown")}
                        disabled={i === shown.length - 1 || busyId != null}
                        onClick={() => { void move(r, 1); }}
                      >
                        <ArrowIcon dir="down" />
                      </IconButton>
                    </>
                  ) : (
                    <span className={styles.orderNum}>{i + 1}</span>
                  )}
                </div>

                <div className={styles.sentence}>
                  <BankRuleSentence
                    rule={r}
                    target={labels.get(r.target_kind) ?? r.target_kind}
                    off={!r.enabled}
                  />
                  <div className={styles.meta}>
                    {r.description && <span className={styles.name}>{r.description}</span>}
                    <span>
                      {tn("rules.matches", r.match_count, fmtNumber)}
                      {r.account_filter_label ? ` · ${r.account_filter_label}` : ""}
                    </span>
                  </div>
                </div>

                <div className={styles.actions}>
                  <RowActions
                    title={r.description || r.desc_match_value || t("rules.rule")}
                    actions={[
                      { label: t("rules.edit"), perm: "bank_sync.update", onClick: () => setEditing(r) },
                      {
                        label: t("rules.applyNow"), perm: "bank_sync.update",
                        busy: busyId === r.id, disabled: !r.enabled,
                        onClick: () => handleApply(r),
                      },
                      {
                        label: r.enabled ? t("rules.disable") : t("rules.enable"), perm: "bank_sync.update",
                        busy: busyId === r.id,
                        onClick: () => handleToggle(r),
                      },
                      {
                        label: t("rules.delete"), tone: "danger", perm: "bank_sync.delete",
                        onClick: () => setPendingDelete(r),
                      },
                    ]}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {templateRows.length > 0 && (
        <Card>
          <div className={styles.toolbar}>
            <h2 className={styles.templatesTitle}>{t("rules.templates")}</h2>
            <span className={styles.hint}>{t("rules.templatesHint")}</span>
          </div>
          <BankRuleTemplateList
            rows={templateRows}
            action={(tpl) => (
              <Button
                size="sm" tone="secondary" perm="bank_sync.create"
                onClick={() => setEditing({ template: tpl })}
                aria-label={t("rules.useAria", { name: tpl.name })}
              >
                {t("rules.use")}
              </Button>
            )}
          />
        </Card>
      )}

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={
          editing === "new" ? t("rules.newTitle")
            : editing != null && "template" in editing ? t("rules.fromTemplate")
              : t("rules.editTitle")
        }
        size="lg"
      >
        {editing != null && (
          <BankRuleForm
            key={
              editing === "new" ? "new"
                : "template" in editing ? `t${editing.template.id}` : editing.id
            }
            editingId={editing === "new" || "template" in editing ? null : editing.id}
            initial={
              editing === "new" ? undefined
                : "template" in editing ? formValuesFromTemplate(editing.template)
                  : formValuesFromRule(editing)
            }
            onCancel={() => setEditing(null)}
            onSaved={async (resp, mode) => {
              setEditing(null);
              await rules.refetch();
              toast({
                message: mode === "edit"
                  ? t("rules.updated")
                  : `${t("rules.created")}${describeAppliedRule(resp.applied)}`,
                tone: "success",
              });
            }}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={pendingDelete != null}
        title={t("rules.deleteTitle")}
        message={t("rules.deleteBody", {
          rule: pendingDelete ? ruleSentence(pendingDelete, labels) : "",
        })}
        confirmLabel={t("rules.delete")}
        confirmTone="danger"
        busy={deleteBusy}
        onConfirm={() => { void doDelete(); }}
        onCancel={() => setPendingDelete(null)}
      />
    </PageShell>
  );
}

function ArrowIcon({ dir }: { dir: "up" | "down" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {dir === "up" ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M19 12l-7 7-7-7" />}
    </svg>
  );
}
