import { useNavigate, useParams } from "react-router-dom";

import { ticketKindLabel, useTransaction } from "../api/posimport";
import {
  Alert, Button, Card, ErrorState, KpiCard, KpiGrid,
  Loading, PageHeader, PageShell, Pill, Section, Table,
  tdStyle, thStyle, tokens,
} from "../components/ui";
import { fmtMoney2 } from "../lib/formatters";
import { formatTimestamp } from "../lib/datetime";
import styles from "./TransactionDetail.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT, type MessageKey } from "../i18n";

const LINE_COLUMNS: MessageKey[] = [
  "posTx.colItem", "posTx.colScanCode", "posTx.colQty", "posTx.colPrice", "posTx.colAmount",
];
const TENDER_COLUMNS: MessageKey[] = ["posTx.colTender", "posTx.colType", "posTx.colAmount"];

// /app/transactions/:id (G-6) — one ticket, as the register rang it.
//
// Voided lines are SHOWN, struck through and flagged. That is the
// point of this page: an owner looking for what a cashier voided
// mid-sale finds it here. The ticket's own totals exclude them
// already (server-side), so the line total and the ticket total
// will not agree when there is a void — which is correct, and the
// page says so rather than leaving the reader to wonder.

export default function TransactionDetail() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const numericId = Number(id);
  const query = useTransaction(Number.isFinite(numericId) ? numericId : null);

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
  const voidedLines = tx.lines.filter((l) => l.status === "cancel");
  const soldTotal = tx.lines
    .filter((l) => l.status !== "cancel")
    .reduce((sum, l) => sum + l.amount, 0);

  return (
    <PageShell maxWidth="60rem">
      <PageCrumbs current={tx.transaction_no || `#${tx.id}`} />
      <PageHeader
        title={t("posTx.ticketTitle", { ticket: tx.transaction_no || `#${tx.id}` })}
        subtitle={
          tx.receipt_at ? formatTimestamp(tx.receipt_at) : tx.business_date
        }
        actions={
          <div className={styles.flags}>
            {tx.kind && tx.kind !== "sale" && (
              <Pill tone="neutral">{ticketKindLabel(tx.kind)}</Pill>
            )}
            {tx.has_voided_line && <Pill tone="warning">{t("posTx.voidedItem")}</Pill>}
            {tx.training_mode && <Pill tone="neutral">{t("posTx.training")}</Pill>}
            {tx.offline && <Pill tone="warning">{t("posTx.offline")}</Pill>}
            {tx.suspended && <Pill tone="warning">{t("posTx.suspended")}</Pill>}
            {tx.outside && <Pill tone="neutral">{t("posTx.payAtPump")}</Pill>}
          </div>
        }
      />

      {voidedLines.length > 0 && (
        <Alert tone="warning">
          {voidedLines.length === 1
            ? t("posTx.voidedOne")
            : t("posTx.voidedMany", { count: voidedLines.length })}
        </Alert>
      )}

      <KpiGrid>
        <KpiCard label={t("posTx.items")} value={fmtMoney2(soldTotal)} />
        <KpiCard label={t("posTx.colTax")} value={fmtMoney2(tx.tax)} />
        <KpiCard
          label={t("posTx.colTotal")}
          value={fmtMoney2(tx.grand_total)}
          tone="positive"
        />
      </KpiGrid>

      <Section title={t("posTx.items")}>
        <Card>
          <Table>
            <thead>
              <tr>
                <th style={thStyle}>#</th>
                {LINE_COLUMNS.map((h) => <th key={h} style={thStyle}>{t(h)}</th>)}
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {tx.lines.map((line) => {
                const cancelled = line.status === "cancel";
                return (
                  <tr
                    key={`${line.line_seq}-${line.pos_code}`}
                    className={cancelled ? styles.cancelledRow : ""}
                  >
                    <td style={{ ...tdStyle, fontFamily: tokens.fontMono }}>
                      {line.line_seq}
                    </td>
                    <td style={tdStyle}>
                      {line.description || "—"}
                      {line.is_fuel && line.fuel_position && (
                        <span className={styles.sub}>
                          {" "}{t("posTx.pump", { pump: line.fuel_position })}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: tokens.fontMono }}>
                      {line.pos_code || "—"}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: tokens.fontMono }}>
                      {line.is_fuel && line.gallons
                        ? t("posTx.gal", { gallons: line.gallons.toFixed(3) })
                        : line.quantity.toLocaleString()}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: tokens.fontMono }}>
                      {line.actual_price
                        ? fmtMoney2(line.actual_price) : "—"}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: tokens.fontMono }}>
                      {fmtMoney2(line.amount)}
                    </td>
                    <td style={tdStyle}>
                      {cancelled && <Pill tone="warning">{t("posTx.voided")}</Pill>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </Section>

      {tx.tenders.length > 0 && (
        <Section title={t("posTx.payment")}>
          <Card>
            <Table>
              <thead>
                <tr>
                  {TENDER_COLUMNS.map((h) => (
                    <th key={h} style={thStyle}>{t(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tx.tenders.map((tender, i) => (
                  <tr key={`${tender.code}-${i}`}>
                    <td style={tdStyle}>
                      {tender.code || "—"}
                      {tender.is_change && (
                        <span className={styles.sub}> {t("posTx.change")}</span>
                      )}
                    </td>
                    <td style={tdStyle}>{tender.sub_code || "—"}</td>
                    <td style={{ ...tdStyle, fontFamily: tokens.fontMono }}>
                      {fmtMoney2(tender.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </Section>
      )}

      {/* Register provenance. Useful when reconciling against a
          paper Z-report or chasing a specific till. */}
      <Section title={t("posTx.register")}>
        <Card>
          <dl className={styles.meta}>
            <MetaRow label={t("posTx.businessDate")} value={tx.business_date} />
            <MetaRow label={t("posTx.register")} value={tx.register_id || "—"} />
            <MetaRow label={t("posTx.colCashier")} value={tx.cashier_id || "—"} />
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
      <dd
        className={styles.metaValue}
        style={mono ? { fontFamily: tokens.fontMono } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
