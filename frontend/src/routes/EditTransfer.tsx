import { useMemo } from "react";
import { useParams } from "react-router-dom";

import TransferForm from "../components/TransferForm";
import { ErrorState, Loading, PageHeader, PageShell } from "../components/ui";
import { updateTransfer, useTransfer } from "../api/transfers";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { transferValuesFrom } from "../lib/transferForm";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT } from "../i18n";

// Edit transfer at /app/transfers/:id/edit. The fields, the store's
// lists, the guard and the save flow are the shared `TransferForm`
// (one form with NewTransfer); this page loads the transfer and sends
// back what the form has no input for.

export default function EditTransfer() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const transferId = id ? Number(id) : NaN;
  const identity = getCurrentIdentity();
  const detail = useTransfer(Number.isFinite(transferId) ? transferId : undefined);
  const stored = detail.data?.transfer;
  const initialValues = useMemo(
    () => (stored ? transferValuesFrom(stored) : null),
    [stored],
  );

  if (identity?.store_id == null) {
    return (
      <PageShell maxWidth="62rem">
        <PageHeader title={t("transfer.editTitle")} />
        <p>{t("transfer.editSignIn")}</p>
      </PageShell>
    );
  }

  if (!Number.isFinite(transferId)) {
    return (
      <PageShell maxWidth="62rem">
        <p>{t("transfer.invalidId")}</p>
      </PageShell>
    );
  }

  if (detail.isLoading) {
    return (
      <PageShell maxWidth="62rem">
        <Loading />
      </PageShell>
    );
  }

  if (detail.isError || !stored || !initialValues) {
    return (
      <PageShell maxWidth="62rem">
        <ErrorState
          message={apiErrorMessage(detail.error, t("transfer.loadFailed"))}
          onRetry={() => { void detail.refetch(); }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="62rem">
      <PageCrumbs
        via={[{ label: t("transfer.number", { id: transferId }), to: `/transfers/${transferId}` }]}
        current={t("transfer.edit")}
      />
      <PageHeader
        title={t("transfer.editNumber", { id: transferId })}
        subtitle={t("transfer.editSubtitle")}
      />

      <TransferForm
        initialValues={initialValues}
        keepEmployee={
          stored.employee_id != null
            ? { id: stored.employee_id, name: stored.employee_name || t("transfer.formerEmployee") }
            : null
        }
        storeId={identity.store_id}
        submitLabel={t("transfer.saveChanges")}
        cancelTo={`/transfers/${transferId}`}
        savedMessage={t("transfer.updated")}
        failedMessage={t("transfer.updateFailed")}
        // The PUT replaces the whole row. Commission, notes and the
        // ACH batch have no field on this form: send back what the
        // transfer holds so an edit keeps them.
        save={(values) => updateTransfer(transferId, {
          ...values,
          commission: stored.commission ?? 0,
          status_notes: stored.status_notes ?? "",
          internal_notes: stored.internal_notes ?? "",
          batch_id: stored.batch_id || "",
        })}
      />
    </PageShell>
  );
}
