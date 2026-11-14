import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  batchName, deleteReturnCheckBatch, updateReturnCheckBatch, useReturnCheckBatch,
  type ReturnCheckBatchUpdateBody, type ReturnCheckRow,
} from "../api/returnChecks";
import { apiErrorMessage } from "../lib/api";
import { formatDate } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import {
  Alert, Button, ButtonLink, Card, ConfirmDialog, DataTable, DateInput,
  ErrorState, Field, FormActions, Input, KpiCard, KpiGrid, Loading,
  PageHeader, PageShell, SectionTitle, Textarea, useToast, type DataColumn,
} from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import { ReturnCheckStatusPill } from "../components/ReturnCheckStatusPill";
import formStyles from "./ReturnCheckForm.module.css";
import styles from "./ReturnChecks.module.css";
import { tn, useT, type Translate } from "../i18n";

// One returned batch at /app/return-checks/batches/:id: what it adds
// up to, its own details (a new returned date moves every check in
// it), the checks in it and "Add check". An empty batch can be
// deleted; one with checks cannot (returned checks are never deleted).

function checkColumns(t: Translate): DataColumn<ReturnCheckRow>[] {
  return [
    { key: "customer", header: t("transfer.customer"), render: (r) => r.customer_name },
    { key: "company", header: t("returnCheck.company"), render: (r) => r.company_name || "—" },
    {
      key: "check", header: t("returnCheck.checkNumberShort"),
      render: (r) => <span className={styles.mono}>{r.check_number || "—"}</span>,
    },
    { key: "bank", header: t("returnCheck.bank"), render: (r) => r.payer_bank || "—" },
    {
      key: "amount", header: t("dash.amount"), align: "right",
      render: (r) => <span className={styles.mono}>{fmtMoney2(r.amount)}</span>,
    },
    {
      key: "recovered", header: t("returnCheck.statusRecovered"), align: "right",
      render: (r) => <span className={styles.mono}>{fmtMoney2(r.recovered_total)}</span>,
    },
    { key: "status", header: t("transfer.status"), render: (r) => <ReturnCheckStatusPill status={r.status} /> },
  ];
}

const EMPTY: ReturnCheckBatchUpdateBody = { returned_on: "", reference: "", notes: "" };

export default function ReturnCheckBatch() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const batchId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const detail = useReturnCheckBatch(batchId);

  const [form, setForm] = useState<ReturnCheckBatchUpdateBody>(EMPTY);
  const [baseline, setBaseline] = useState<ReturnCheckBatchUpdateBody>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!detail.data) return;
    const b = detail.data.batch;
    const hydrated = { returned_on: b.returned_on, reference: b.reference ?? "", notes: b.notes ?? "" };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the editable batch fields + dirty baseline from the server row
    setForm(hydrated);
    setBaseline(hydrated);
  }, [detail.data]);

  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const guard = useUnsavedGuard(dirty && !busy, { message: t("returnCheck.batchUnsaved") });

  if (detail.isError && !detail.data) {
    return (
      <PageShell maxWidth="62rem">
        <PageCrumbs current={t("returnCheck.batchTitle")} />
        <PageHeader title={t("returnCheck.batchTitle")} />
        <ErrorState
          message={apiErrorMessage(detail.error, t("returnCheck.batchLoadFailed"))}
          onRetry={() => void detail.refetch()}
          busy={detail.isFetching}
        />
      </PageShell>
    );
  }
  if (!detail.data) return <PageShell maxWidth="62rem"><Loading /></PageShell>;

  const { batch, checks = [] } = detail.data;
  const name = batchName(batch, formatDate);
  const owed = checks
    .filter((c) => c.status === "pending")
    .reduce((sum, c) => sum + Math.max(0, c.amount + c.return_check_fee - c.recovered_total), 0);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await updateReturnCheckBatch(batchId, form);
      await qc.invalidateQueries({ queryKey: ["return-checks"] });
      toast({ message: t("returnCheck.batchUpdated"), tone: "success" });
      setBaseline(form);
    } catch (err) {
      setError(apiErrorMessage(err, t("returnCheck.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    setDeleteError(null); setBusy(true);
    try {
      await deleteReturnCheckBatch(batchId);
      void qc.invalidateQueries({ queryKey: ["return-checks"] });
      toast({ message: t("returnCheck.batchDeleted"), tone: "success" });
      guard.proceed(() => navigate("/return-checks/batches", { replace: true }));
    } catch (err) {
      setDeleteError(apiErrorMessage(err, t("returnCheck.batchDeleteFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell maxWidth="62rem">
      <PageCrumbs current={name} />
      <PageHeader
        title={name}
        subtitle={tn("returnCheck.batchCheckCount", batch.check_count, fmtNumber)}
        actions={(
          <ButtonLink to={`/return-checks/new?batch=${batch.id}`} tone="primary" size="sm">
            {t("returnCheck.addCheck")}
          </ButtonLink>
        )}
      />

      <KpiGrid>
        <KpiCard label={t("returnCheck.amountReturned")} value={fmtMoney2(batch.amount_total)} />
        <KpiCard label={t("returnCheck.statusRecovered")} value={fmtMoney2(batch.recovered_total)} />
        <KpiCard
          label={t("returnCheck.stillOwed")} value={fmtMoney2(owed)}
          tone={owed > 0 ? "warning" : "neutral"}
          sub={tn("returnCheck.openCount", batch.open_count, fmtNumber)}
        />
      </KpiGrid>

      <Card>
        <SectionTitle>{t("returnCheck.checksInBatch")}</SectionTitle>
        <DataTable
          columns={checkColumns(t)}
          rows={checks}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/return-checks/${r.id}/edit`)}
          rowLabel={(r) => t("returnCheck.openFrom", { name: r.customer_name })}
          emptyTitle={t("returnCheck.batchEmpty")}
        />
      </Card>

      <form onSubmit={onSave} className="ds-form">
        <Card>
          <SectionTitle>{t("returnCheck.batchDetails")}</SectionTitle>
          <div className={formStyles.fieldGrid}>
            <Field label={t("returnCheck.returnedOn")} hint={t("returnCheck.batchDateHint")}>
              <DateInput required value={form.returned_on}
                onChange={(e) => setForm((f) => ({ ...f, returned_on: e.target.value }))} />
            </Field>
            <Field label={t("returnCheck.referenceOptional")} hint={t("returnCheck.referenceHint")}>
              <Input type="text" maxLength={80} value={form.reference ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} />
            </Field>
          </div>
          <Field label={t("batch.notes")}>
            <Textarea rows={2} value={form.notes ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
        </Card>
        {error && <Alert tone="error">{error}</Alert>}
        <FormActions guard={guard}>
          {checks.length === 0 && (
            <Button type="button" tone="danger" perm="return_checks.delete"
              disabled={busy} onClick={() => setConfirmDelete(true)}>
              {t("returnCheck.deleteBatch")}
            </Button>
          )}
          <Button type="submit" perm="return_checks.update" busy={busy}
            disabled={busy || !dirty || !form.returned_on}>
            {busy ? t("transfer.saving") : t("transfer.saveChanges")}
          </Button>
        </FormActions>
      </form>

      <ConfirmDialog
        open={confirmDelete}
        title={t("returnCheck.deleteBatchTitle")}
        message={t("returnCheck.deleteBatchMessage", { name })}
        confirmLabel={t("returnCheck.deleteBatch")}
        confirmTone="danger"
        busy={busy}
        error={deleteError}
        onConfirm={() => { void onDelete(); }}
        onCancel={() => { setConfirmDelete(false); setDeleteError(null); }}
      />
    </PageShell>
  );
}
