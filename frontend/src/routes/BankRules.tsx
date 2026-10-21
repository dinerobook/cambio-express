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
      toast({ message: r.enabled ? "Rule disabled." : "Rule enabled.", tone: "success" });
    } catch (e) {
      toastApiError(e, "Could not update rule.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleApply(r: BankRuleRow) {
    setBusyId(r.id);
    try {
      const resp = await applyRule(r.id);
      await rules.refetch();
      toast({ message: `Rule applied.${describeAppliedRule(resp.applied)}`, tone: "success" });
    } catch (e) {
      toastApiError(e, "Could not apply rule.");
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
      toastApiError(e, "Could not reorder.");
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
      toast({ message: "Rule deleted.", tone: "success" });
    } catch (e) {
      // Keep the prompt open so the operator can retry or cancel; a
      // bare rejection here used to vanish as an unhandled promise.
      toastApiError(e, "Could not delete rule.");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />

      <PageHeader
        title="Bank rules"
        subtitle="Rules categorize new bank transactions as they sync — and can book them straight onto the daily book. They apply top to bottom; the first match wins."
        actions={
          <div className={styles.headerActions}>
            <ButtonLink to="/bank-transactions" tone="secondary">
              Bank transactions
            </ButtonLink>
            <ButtonLink to="/monthly/categories" tone="secondary">
              P&amp;L categories
            </ButtonLink>
            <Button perm="bank_sync.create" onClick={() => setEditing("new")}>
              + New rule
            </Button>
          </div>
        }
      />

      <Card>
        <div className={styles.toolbar}>
          <span className={styles.count}>
            {rows.length} rule{rows.length === 1 ? "" : "s"}
          </span>
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search rules…"
            aria-label="Search rules"
            className={styles.search}
          />
        </div>

        {rules.isLoading && <Loading />}
        {rules.isError && (
          <ErrorState
            message="Could not load bank rules."
            onRetry={() => { void rules.refetch(); }}
          />
        )}
        {!rules.isLoading && !rules.isError && rows.length === 0 && (
          <EmptyState
            title="No rules yet"
            body="Create one here, or open a transaction on the bank transactions page and choose “Make a rule” — the form fills itself in from that row."
          />
        )}
        {!rules.isLoading && rows.length > 0 && shown.length === 0 && (
          <EmptyState title="No rules match that search." />
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
                        size="sm" tone="ghost" title="Move up"
                        disabled={i === 0 || busyId != null}
                        onClick={() => { void move(r, -1); }}
                      >
                        <ArrowIcon dir="up" />
                      </IconButton>
                      <span className={styles.orderNum}>{i + 1}</span>
                      <IconButton
                        size="sm" tone="ghost" title="Move down"
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
                      {r.match_count} match{r.match_count === 1 ? "" : "es"}
                      {r.account_filter_label ? ` · ${r.account_filter_label}` : ""}
                    </span>
                  </div>
                </div>

                <div className={styles.actions}>
                  <RowActions
                    title={r.description || r.desc_match_value || "Rule"}
                    actions={[
                      { label: "Edit", perm: "bank_sync.update", onClick: () => setEditing(r) },
                      {
                        label: "Apply now", perm: "bank_sync.update",
                        busy: busyId === r.id, disabled: !r.enabled,
                        onClick: () => handleApply(r),
                      },
                      {
                        label: r.enabled ? "Disable" : "Enable", perm: "bank_sync.update",
                        busy: busyId === r.id,
                        onClick: () => handleToggle(r),
                      },
                      {
                        label: "Delete", tone: "danger", perm: "bank_sync.delete",
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
            <h2 className={styles.templatesTitle}>Templates</h2>
            <span className={styles.hint}>
              Ready-made rules. Use one to add it to your rules; you can
              change it before saving.
            </span>
          </div>
          <BankRuleTemplateList
            rows={templateRows}
            action={(t) => (
              <Button
                size="sm" tone="secondary" perm="bank_sync.create"
                onClick={() => setEditing({ template: t })}
                aria-label={`Use template ${t.name}`}
              >
                Use
              </Button>
            )}
          />
        </Card>
      )}

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={
          editing === "new" ? "New rule"
            : editing != null && "template" in editing ? "New rule from template"
              : "Edit rule"
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
                  ? "Rule updated."
                  : `Rule created.${describeAppliedRule(resp.applied)}`,
                tone: "success",
              });
            }}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete this rule?"
        message={
          `Delete rule "${pendingDelete ? ruleSentence(pendingDelete, labels) : ""}"? `
          + "Transactions it already tagged keep their category; only "
          + "future syncs stop applying it."
        }
        confirmLabel="Delete"
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
