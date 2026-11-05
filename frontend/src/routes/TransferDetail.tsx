import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { deleteTransfer, useTransfer } from "../api/transfers";
import { fmtMoney2 } from "../lib/formatters";
import { formatDate } from "../lib/datetime";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Button,
  ButtonLink, Card, ConfirmDialog, Empty, ErrorState, Loading, PageHeader,
  PageShell, Section, tokens, useToast,
} from "../components/ui";
import styles from "./TransferDetail.module.css";
import TransferKindPill from "../components/TransferKindPill";
import {
  isDebitCard, isPayout, serviceLabel, statusLabel, transferWording,
} from "../lib/transferKinds";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT } from "../i18n";

// Single-transfer detail page. Backed by /api/v2/transfers/{id}
// — same shape as a row in the list, so the read-only detail
// view here is mostly a labeled flat layout. The legacy
// /transfers/<id>/edit Jinja page handles edits today;
// editing migrates in SPA-N (write-side). Delete (transfers.delete,
// store admins by default) clears a mistaken entry after a confirm.
export default function TransferDetail() {
  const t = useT();
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
      toast({ message: t("transfer.deleted"), tone: "success" });
      navigate("/transfers", { replace: true });
    } catch (err) {
      setDeleteError(apiErrorMessage(err, t("transfer.deleteFailed")));
      setDeleting(false);
    }
  }

  if (Number.isNaN(id)) {
    return (
      <PageShell maxWidth="52rem" gap="1rem">
        <Empty>{t("transfer.invalidId")}</Empty>
      </PageShell>
    );
  }

  if (identity?.store_id == null) {
    return (
      <PageShell maxWidth="52rem" gap="1rem">
        <Empty>{t("transfer.detailSignIn")}</Empty>
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
          message={apiErrorMessage(error, t("transfer.loadFailed"))}
          onRetry={() => { void refetch(); }}
        />
      </PageShell>
    );
  }

  if (!data) return null;
  const row = data.transfer;
  const words = transferWording(row.service_type);

  return (
    <PageShell maxWidth="52rem" gap="1rem">
      <PageCrumbs current={t("transfer.number", { id: String(id) })} />


      <PageHeader
        title={t("transfer.number", { id: row.id })}
        subtitle={(
          <span style={{ fontFamily: tokens.fontMono }}>
            {row.send_date} · {row.company} · {serviceLabel(row.service_type)}{" "}
            <TransferKindPill
              serviceType={row.service_type}
              paymentMethod={row.payment_method}
            />
          </span>
        )}
        actions={(
          <>
            <ButtonLink to={`/transfers/${row.id}/edit`} tone="secondary" size="sm">
              {t("transfer.edit")}
            </ButtonLink>
            <Button
              tone="danger" size="sm" perm="transfers.delete"
              onClick={() => { setDeleteError(null); setConfirming(true); }}
            >
              {t("transfer.delete")}
            </Button>
          </>
        )}
      />

      <Section title={words.customer}>
        <Card padding="1.25rem 1.5rem">
          <DetailRow label={t("transfer.name")} value={row.sender_name || "—"} />
        </Card>
      </Section>

      <Section title={words.other}>
        <Card padding="1.25rem 1.5rem">
          <DetailRow label={t("transfer.name")} value={row.recipient_name || "—"} />
          <DetailRow label={words.country} value={row.country || "—"} />
        </Card>
      </Section>

      <Section title={t("transfer.amounts")}>
        <Card padding="1.25rem 1.5rem">
          <DetailRow label={words.amount} value={fmtMoney2(row.send_amount)} mono />
          {!isPayout(row.service_type) && (
            <>
              <DetailRow label={t("transfer.fee")} value={fmtMoney2(row.fee)} mono />
              <DetailRow label={t("transfer.federalTax")} value={fmtMoney2(row.federal_tax)} mono />
              <DetailRow
                label={t("transfer.paidBy")}
                value={isDebitCard(row.payment_method) ? t("transfer.debitCard") : t("transfer.cash")}
              />
            </>
          )}
          <DetailRow
            label={words.total}
            value={fmtMoney2(row.total_collected)}
            mono
            emphasis
          />
        </Card>
      </Section>

      <Section title={t("transfer.statusRefs")}>
        <Card padding="1.25rem 1.5rem">
          <DetailRow label={t("transfer.status")} value={statusLabel(row.status)} />
          <DetailRow label={t("transfer.confirmNumber")} value={row.confirm_number || "—"} mono />
          <DetailRow label={t("transfer.batchId")} value={row.batch_id || "—"} mono />
          <DetailRow label={t("transfer.employee")} value={row.employee_name || "—"} />
        </Card>
      </Section>

      <ConfirmDialog
        open={confirming}
        title={t("transfer.deleteTitle", { id: row.id })}
        message={t("transfer.deleteMessage", {
          sender: row.sender_name || "?",
          recipient: row.recipient_name || "?",
          amount: fmtMoney2(row.total_collected),
          date: formatDate(row.send_date),
        })}
        confirmLabel={t("transfer.deleteConfirm")}
        confirmTone="danger"
        busy={deleting}
        error={deleteError}
        onConfirm={() => { void doDelete(row.id); }}
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


