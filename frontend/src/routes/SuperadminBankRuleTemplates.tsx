import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  createRuleTemplate,
  deleteRuleTemplate,
  updateRuleTemplate,
  useAllRuleTemplates,
  useTemplateCategories,
  type BankRuleTemplateRow,
} from "../api/bankSync";
import { BankRuleForm } from "../components/BankRuleForm";
import { BankRuleTemplateList } from "../components/BankRuleTemplateList";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  Button, Card, ConfirmDialog, EmptyState, ErrorState,
  Loading, Modal, PageHeader, PageShell, RowActions, useToast,
} from "../components/ui";
import { formValuesFromTemplateRow, templateBodyFromFormValues } from "../lib/bankRules";
import { useApiErrorToast } from "../lib/useApiErrorToast";

// /app/superadmin/bank-rule-templates — bank rules written once for
// every store ("Intermex commission deposit", any transaction type).
// A shown template is listed on every store's Bank rules page, where
// "Use" copies it into the store's own rules. Editing or deleting a
// template here never changes a rule a store already made from it
// (BankSync INVARIANTS "Rule templates"). The form is the stores'
// own BankRuleForm in template mode.

const LIST_KEY = ["superadmin", "bank-rule-templates"];

export default function SuperadminBankRuleTemplates() {
  const qc = useQueryClient();
  const templates = useAllRuleTemplates();
  const categories = useTemplateCategories();
  const toast = useToast();
  const toastApiError = useApiErrorToast();

  const [editing, setEditing] = useState<BankRuleTemplateRow | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BankRuleTemplateRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const rows = templates.data?.rows ?? [];

  async function refresh() {
    await qc.invalidateQueries({ queryKey: LIST_KEY });
  }

  async function doDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      await deleteRuleTemplate(pendingDelete.id);
      await refresh();
      setPendingDelete(null);
      toast({ message: "Template deleted.", tone: "success" });
    } catch (e) {
      toastApiError(e, "Could not delete template.");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />

      <PageHeader
        title="Rule templates"
        subtitle="Bank rules every store can use. Stores see the shown ones on their Bank rules page and add a copy to their own rules; changing a template here never changes a store's rule."
        actions={
          <Button onClick={() => setEditing("new")}>+ New template</Button>
        }
      />

      <Card>
        {templates.isLoading && <Loading />}
        {templates.isError && (
          <ErrorState
            message="Could not load rule templates."
            onRetry={() => { void templates.refetch(); }}
          />
        )}
        {!templates.isLoading && !templates.isError && rows.length === 0 && (
          <EmptyState
            title="No templates yet"
            body="Create one, for example a rule that tags the monthly Intermex commission deposit."
          />
        )}
        {rows.length > 0 && (
          <BankRuleTemplateList
            rows={rows}
            action={(t) => (
              <RowActions
                title={t.name}
                actions={[
                  { label: "Edit", onClick: () => setEditing(t) },
                  { label: "Delete", tone: "danger", onClick: () => setPendingDelete(t) },
                ]}
              />
            )}
          />
        )}
      </Card>

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "New template" : "Edit template"}
        size="lg"
      >
        {editing != null && (
          <BankRuleForm
            key={editing === "new" ? "new" : editing.id}
            editingId={editing === "new" ? null : editing.id}
            initial={editing === "new" ? undefined : formValuesFromTemplateRow(editing)}
            onCancel={() => setEditing(null)}
            template={{
              groups: categories.data?.groups,
              submit: async (values) => {
                const body = templateBodyFromFormValues(values);
                if (editing === "new") await createRuleTemplate(body);
                else await updateRuleTemplate(editing.id, body);
                setEditing(null);
                await refresh();
                toast({
                  message: editing === "new" ? "Template created." : "Template saved.",
                  tone: "success",
                });
              },
            }}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete this template?"
        message={
          `Delete template "${pendingDelete?.name ?? ""}"? Stores stop seeing it; `
          + "rules they already made from it stay as they are."
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
