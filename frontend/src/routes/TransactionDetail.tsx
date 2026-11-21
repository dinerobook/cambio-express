import { useNavigate, useParams } from "react-router-dom";

import { useSessionStatus } from "../api/account";
import {
  cashierLabel, eventDetailLabel, ticketKindLabel, useTransaction,
} from "../api/posimport";
import {
  Button, Card, ErrorState, Loading, PageHeader, PageShell, Pill, Section,
} from "../components/ui";
import { Receipt } from "../components/Receipt";
import { TicketNotes } from "../components/ReceiptPanel";
import { formatTimestamp } from "../lib/datetime";
import styles from "./TransactionDetail.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT } from "../i18n";

// /app/transactions/:id (G-6) — one ticket, as the register rang it.
//
// The receipt is the shared one (components/Receipt.tsx — the
// Transactions side panel draws the same): voided lines are SHOWN,
// struck through, at the price they rang, and never counted. Below
// it, where the ticket came from (register, till, times, the journal
// file) for reconciling against a paper Z-report.
//
// A fuel prepay is two tickets: the deposit rung when the customer
// paid, and the completion rung when the pump stopped, restating
// the whole ticket. The deposit is marked superseded and counted
// nowhere; each half links to the other when both are imported
// (TicketNotes).

export default function TransactionDetail() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const numericId = Number(id);
  const query = useTransaction(Number.isFinite(numericId) ? numericId : null);
  const storeName = useSessionStatus().data?.store_name;

  if (query.isLoading) {
    return (
      <PageShell>
        <PageHeader title={t("posTx.title")} />
        <Loading />
      </PageShell>
    );
  }
  if (query.isError || !query.data) {
    return (
      <PageShell>
        <PageHeader title={t("posTx.title")} />
        <ErrorState
          message={t("posTx.detailLoadFailed")}
          onRetry={() => { void query.refetch(); }}
        />
      </PageShell>
    );
  }

  const tx = query.data.transaction;
  const at = tx.ended_at ?? tx.started_at;

  return (
    <PageShell maxWidth="60rem">
      <PageCrumbs current={tx.transaction_no || `#${tx.id}`} />
      <PageHeader
        title={t("posTx.ticketTitle", { ticket: tx.transaction_no || `#${tx.id}` })}
        subtitle={at ? formatTimestamp(at) : tx.business_date}
        actions={
          <div className={styles.flags}>
            {tx.detail_type
              ? <Pill tone={tx.detail_type === "NoSale" ? "warning" : "neutral"}>{eventDetailLabel(tx.detail_type)}</Pill>
              : tx.kind && tx.kind !== "sale" && <Pill tone="neutral">{ticketKindLabel(tx.kind)}</Pill>}
            {tx.has_voided_line && <Pill tone="warning">{t("posTx.voidedItem")}</Pill>}
            {tx.training_mode && <Pill tone="neutral">{t("posTx.training")}</Pill>}
            {tx.offline && <Pill tone="warning">{t("posTx.offline")}</Pill>}
            {tx.suspended && <Pill tone="warning">{t("posTx.suspended")}</Pill>}
            {tx.outside && <Pill tone="neutral">{t("posTx.payAtPump")}</Pill>}
            {tx.superseded && <Pill tone="neutral">{t("posTx.superseded")}</Pill>}
          </div>
        }
      />

      <TicketNotes tx={tx} />

      <div className={styles.layout}>
        <Receipt tx={tx} storeName={storeName} />

        {/* Register provenance. Useful when reconciling against a
            paper Z-report or chasing a specific till. */}
        <Section title={t("posTx.register")}>
          <Card>
            <dl className={styles.meta}>
              <MetaRow label={t("posTx.businessDate")} value={tx.business_date} />
              <MetaRow label={t("posTx.register")} value={tx.register_id || "—"} />
              <MetaRow
                label={t("posTx.colCashier")}
                value={cashierLabel(tx.cashier_id, tx.cashier_name)}
              />
              <MetaRow label={t("posTx.till")} value={tx.till_id || "—"} />
              <MetaRow
                label={t("posTx.started")}
                value={tx.started_at ? formatTimestamp(tx.started_at) : "—"}
              />
              <MetaRow
                label={t("posTx.ended")}
                value={tx.ended_at ? formatTimestamp(tx.ended_at) : "—"}
              />
              <MetaRow label={t("posTx.journalFile")} value={tx.source_file || "—"} mono />
            </dl>
          </Card>
        </Section>
      </div>

      <div className={styles.footerRow}>
        <Button tone="secondary" onClick={() => navigate("/transactions")}>
          {t("posTx.back")}
        </Button>
      </div>
    </PageShell>
  );
}

function MetaRow({
  label, value, mono = false,
}: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.metaRow}>
      <dt className={styles.metaLabel}>{label}</dt>
      <dd className={mono ? `${styles.metaValue} ${styles.mono}` : styles.metaValue}>
        {value}
      </dd>
    </div>
  );
}
