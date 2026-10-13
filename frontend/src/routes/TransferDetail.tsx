import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { deleteTransfer, useTransfer } from "../api/transfers";
import { fmtMoney2 } from "../lib/formatters";
import { formatDate } from "../lib/datetime";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Breadcrumbs, Button,
  ButtonLink, Card, ConfirmDialog, Empty, ErrorState, Loading, PageHeader,
  PageShell, Section, tokens, useToast,
} from "../components/ui";
import styles from "./TransferDetail.module.css";

// Single-transfer detail page. Backed by /api/v2/transfers/{id}
// — same shape as a row in the list, so the read-only detail
// view here is mostly a labeled flat layout. The legacy
// /transfers/<id>/edit Jinja page handles edits today;
// editing migrates in SPA-N (write-side). Delete (transfers.delete,
// store admins by default) clears a mistaken entry after a confirm.
export default function TransferDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id ? Number(params.id) : undefined;
  const identity = getCurrentIdentity();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useTransfer(id);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function doDelete(transferId: number) {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTransfer(transferId);
      await queryClient.invalidateQueries({ queryKey: ["transfers"] });
      toast({ message: "Transfer deleted.", tone: "success" });
      navigate("/transfers", { replace: true });
    } catch (err) {
      setDeleteError(apiErrorMessage(err, "Could not delete the transfer."));
      setDeleting(false);
    }
  }

  if (Number.isNaN(id)) {
    return (
      <PageShell maxWidth="52rem" gap="1rem">
        <Empty>Invalid transfer ID.</Empty>
      </PageShell>
    );
  }

  if (identity?.store_id == null) {
    return (
      <PageShell maxWidth="52rem" gap="1rem">
        <Empty>Sign in as a store admin to view transfer details.</Empty>
      </PageShell>
    );
  }

  if (isLoading) {
    return (
      <PageShell maxWidth="52rem" gap="1rem">
        <Loading />
      </PageShell>
    );
  }

  if (isError) {
    return (
      <PageShell maxWidth="52rem" gap="1rem">
        <ErrorState
          message={apiErrorMessage(error, "Could not load transfer")}
          onRetry={() => { void refetch(); }}
        />
      </PageShell>
    );
  }

  if (!data) return null;
  const t = data.transfer;

  return (
    <PageShell maxWidth="52rem" gap="1rem">
      <Breadcrumbs crumbs={[{ label: "Transfers", to: "/transfers" }, { label: `Transfer #${id}` }]} />


      <PageHeader
        title={`Transfer #${t.id}`}
        subtitle={(
          <span style={{ fontFamily: tokens.fontMono }}>
            {t.send_date} · {t.company} · {t.service_type}
          </span>
        )}
        actions={(
          <>
            <ButtonLink href={`/transfers/${t.id}/edit`} tone="secondary" size="sm">
              Edit
            </ButtonLink>
            <Button
              tone="danger" size="sm" perm="transfers.delete"
              onClick={() => { setDeleteError(null); setConfirming(true); }}
            >
              Delete
            </Button>
          </>
        )}
      />

      <Section title="Sender">
        <Card padding="1.25rem 1.5rem">
          <DetailRow label="Name" value={t.sender_name || "—"} />
        </Card>
      </Section>

      <Section title="Recipient">
        <Card padding="1.25rem 1.5rem">
          <DetailRow label="Name" value={t.recipient_name || "—"} />
          <DetailRow label="Country" value={t.country || "—"} />
        </Card>
      </Section>

      <Section title="Amounts">
        <Card padding="1.25rem 1.5rem">
          <DetailRow label="Send amount" value={fmtMoney2(t.send_amount)} mono />
          <DetailRow label="Fee"         value={fmtMoney2(t.fee)} mono />
          <DetailRow label="Federal tax" value={fmtMoney2(t.federal_tax)} mono />
          <DetailRow
            label="Total collected"
            value={fmtMoney2(t.total_collected)}
            mono
            emphasis
          />
        </Card>
      </Section>

      <Section title="Status & references">
        <Card padding="1.25rem 1.5rem">
          <DetailRow label="Status" value={t.status} />
          <DetailRow label="Confirmation #" value={t.confirm_number || "—"} mono />
          <DetailRow label="Batch ID"  value={t.batch_id || "—"} mono />
          <DetailRow label="Employee"  value={t.employee_name || "—"} />
        </Card>
      </Section>

      <ConfirmDialog
        open={confirming}
        title={`Delete transfer #${t.id}?`}
        message={(
          <>
            {t.sender_name || "?"} → {t.recipient_name || "?"},{" "}
            {fmtMoney2(t.total_collected)} collected on {formatDate(t.send_date)}. It comes
            off the transfer list, batches and reports. This can't be undone;
            the activity log keeps a note of what was deleted.
          </>
        )}
        confirmLabel="Delete transfer"
        confirmTone="danger"
        busy={deleting}
        error={deleteError}
        onConfirm={() => { void doDelete(t.id); }}
        onCancel={() => setConfirming(false)}
      />
    </PageShell>
  );
}

function DetailRow({
  label, value, mono, emphasis,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  emphasis?: boolean;
}) {
  const valueClass = emphasis
    ? styles.rowValueEmphasis
    : mono
      ? styles.rowValueMono
      : styles.rowValue;
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}


