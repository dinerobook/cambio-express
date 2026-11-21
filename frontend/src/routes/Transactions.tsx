import { useState } from "react";

import { useSessionStatus } from "../api/account";
import {
  cashierLabel, eventDetailLabel, fetchPosTransactionsPage, ticketKindLabel,
  useTransactions, type PosTransactionRow,
} from "../api/posimport";
import { csvMoney } from "../lib/csv";
import {
  AppLink, Card, DataTable, DateInput, Field,
  Input, KpiCard, KpiGrid, PageShell, Pill,
  TabsBar, TabsButton, tokens, type DataColumn,
} from "../components/ui";
import { ReceiptSplit } from "../components/ReceiptPanel";
import { useOpenReceipt } from "../lib/useOpenReceipt";
import { TransactionsHeader } from "../components/TransactionsHeader";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { csvTimestamp, daysAgoIso, formatTimestamp } from "../lib/datetime";
import styles from "./Transactions.module.css";
import { t, useT, type MessageKey } from "../i18n";

// /app/transactions (G-6) — every register ticket, as receipts.
//
// Built on what the owner's other back offices show (Cronysoft's
// receipts, 2026-11-20): one tab per kind of ticket a manager hunts
// for — refunds, voids, tickets with a voided item, drawer opens with
// no sale — each with its count, and the chosen ticket drawn as its
// receipt beside the list (Receipt.tsx). On a narrow window the
// receipt opens as its own page instead.
//
// A voided item is FLAGGED, not hidden: the whole reason to open
// this screen is to see the void. The ticket's own totals already
// leave the cancelled line out. "Total rung" adds sales and refunds
// only (server-side, `counts_toward_sales`): a whole voided ticket
// still carries Passport's full grand total, so it is listed and
// never summed, like a no-sale, a register open or a fuel prepay
// deposit its pump completion superseded.

type TabKey = "" | "sale" | "refund" | "void" | "voided" | "no_sale";

const TABS: {
  key: TabKey; label: MessageKey; count: string;
  kind: string; voided: boolean;
}[] = [
  { key: "", label: "posTx.tabAll", count: "all", kind: "", voided: false },
  { key: "sale", label: "posTx.tabSales", count: "sale", kind: "sale", voided: false },
  { key: "refund", label: "posTx.tabRefunds", count: "refund", kind: "refund", voided: false },
  { key: "void", label: "posTx.tabVoids", count: "void", kind: "void", voided: false },
  { key: "voided", label: "posTx.tabVoidedItems", count: "voided_items", kind: "", voided: true },
  { key: "no_sale", label: "posTx.tabNoSales", count: "no_sale", kind: "no_sale", voided: false },
];

const MONO = { fontFamily: tokens.fontMono };

// The event's own end time, else its start (never ReceiptTime).
const at = (r: PosTransactionRow) => r.ended_at ?? r.started_at;

// Built during render so the headings follow a language switch.
const columns = (): DataColumn<PosTransactionRow>[] => [
  {
    key: "time", header: t("posTx.colTime"),
    render: (r) => (
      <span className={styles.nowrap}>
        {at(r) ? formatTimestamp(at(r)) : r.business_date}
      </span>
    ),
    csv: (r) => (at(r) ? csvTimestamp(at(r)) : r.business_date),
  },
  {
    key: "ticket", header: t("posTx.colTicket"),
    render: (r) => (
      <AppLink to={`/transactions/${r.id}`} className="ds-link" style={MONO}>
        {r.transaction_no || `#${r.id}`}
      </AppLink>
    ),
    csv: (r) => r.transaction_no || `#${r.id}`,
  },
  { key: "register", header: t("posTx.colRegister"), render: (r) => r.register_id || "—", csv: (r) => r.register_id },
  {
    key: "cashier", header: t("posTx.colCashier"),
    render: (r) => cashierLabel(r.cashier_id, r.cashier_name),
    csv: (r) => r.cashier_name || r.cashier_id,
  },
  { key: "items", header: t("posTx.colItems"), align: "right", render: (r) => <span style={MONO}>{r.item_count}</span>,
    csv: (r) => r.item_count },
  { key: "total", header: t("posTx.colTotal"), align: "right", render: (r) => <span style={MONO}>{fmtMoney2(r.grand_total)}</span>,
    csv: (r) => csvMoney(r.grand_total) },
  {
    key: "flags", header: "", label: "", csvHeader: t("posTx.colFlags"),
    csv: (r) => [
      r.detail_type ? eventDetailLabel(r.detail_type) : "",
      r.kind && r.kind !== "sale" && !r.detail_type ? ticketKindLabel(r.kind) : "",
      r.has_voided_line ? t("posTx.voidedItem") : "",
      r.training_mode ? t("posTx.training") : "",
      r.offline ? t("posTx.offline") : "",
      r.suspended ? t("posTx.suspended") : "",
      r.superseded ? t("posTx.superseded") : "",
    ].filter(Boolean).join("; "),
    render: (r) => (
      <div className={styles.flags}>
        {r.detail_type
          ? <Pill tone={r.detail_type === "NoSale" ? "warning" : "neutral"}>{eventDetailLabel(r.detail_type)}</Pill>
          : r.kind && r.kind !== "sale" && <Pill tone="neutral">{ticketKindLabel(r.kind)}</Pill>}
        {r.has_voided_line && <Pill tone="warning">{t("posTx.voidedItem")}</Pill>}
        {r.training_mode && <Pill tone="neutral">{t("posTx.training")}</Pill>}
        {r.offline && <Pill tone="warning">{t("posTx.offline")}</Pill>}
        {r.suspended && <Pill tone="warning">{t("posTx.suspended")}</Pill>}
        {r.superseded && <Pill tone="neutral">{t("posTx.superseded")}</Pill>}
      </div>
    ),
  },
];

export default function Transactions() {
  useT(); // re-render on a language switch
  const storeName = useSessionStatus().data?.store_name;
  const receipt = useOpenReceipt();
  const [defaults] = useState(() => ({ start: daysAgoIso(6), end: daysAgoIso(0) }));
  const filters = useUrlFilterState({
    q: "", tab: "", start: defaults.start, end: defaults.end,
  }, { pageSizeKey: "pos-transactions" });
  const tab = TABS.find((x) => x.key === filters.params.tab) ?? TABS[0];
  const listQuery = {
    start: filters.params.start,
    end: filters.params.end,
    q: filters.params.q,
    kind: tab.kind,
    voidedOnly: tab.voided,
  };
  const list = useTransactions({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const data = list.data;
  const counts = data?.kind_counts;

  return (
    <PageShell maxWidth="92rem">
      <TransactionsHeader start={filters.params.start} end={filters.params.end} />

      {/* The kit filter bar: search first, then the range, on one row. */}
      <div className="ds-filter-bar">
        <Field label={t("posTx.search")}>
          <Input
            type="search"
            placeholder={t("posTx.searchPlaceholder")}
            value={filters.draft.q ?? filters.params.q}
            onChange={(e) => filters.debounced("q", e.target.value)}
          />
        </Field>
        <Field label={t("posTx.from")}>
          <DateInput
            value={filters.params.start}
            onChange={(e) => filters.setParam("start", e.target.value)}
          />
        </Field>
        <Field label={t("posTx.to")}>
          <DateInput
            value={filters.params.end}
            onChange={(e) => filters.setParam("end", e.target.value)}
          />
        </Field>
      </div>

      {data && (
        <KpiGrid>
          <KpiCard
            label={t("posTx.tickets")}
            value={fmtNumber(counts?.all ?? data.total)}
            sub={`${filters.params.start} → ${filters.params.end}`}
          />
          <KpiCard
            label={t("posTx.totalRung")}
            value={fmtMoney2(data.total_grand)}
            tone="positive"
            sub={tab.key ? t(tab.label, { count: fmtNumber(data.total) }) : undefined}
          />
          <KpiCard
            label={t("posTx.withVoided")}
            value={fmtNumber(counts?.voided_items ?? data.voided_count)}
            tone={(counts?.voided_items ?? data.voided_count) > 0 ? "warning" : "positive"}
          />
          <KpiCard
            label={t("posTx.noSales")}
            value={fmtNumber(counts?.no_sale ?? 0)}
            tone={(counts?.no_sale ?? 0) > 0 ? "warning" : "positive"}
          />
        </KpiGrid>
      )}

      <Card>
        <TabsBar>
          {TABS.map((x) => (
            <TabsButton
              key={x.key || "all"}
              active={tab.key === x.key}
              onClick={() => filters.setParam("tab", x.key)}
            >
              {t(x.label, { count: counts ? fmtNumber(counts[x.count] ?? 0) : "—" })}
            </TabsButton>
          ))}
        </TabsBar>

        <ReceiptSplit selected={receipt.selected} storeName={storeName} onClose={receipt.close}>
            <DataTable
              columns={columns()}
              rows={data?.rows}
              rowKey={(r) => r.id}
              onRowClick={(r) => receipt.open(r.id)}
              rowLabel={(r) => t("posTx.openTicket", { ticket: r.transaction_no || r.id })}
              rowClassName={(r) => receipt.rowClass(r.id)}
              isLoading={list.isLoading} isError={list.isError} error={list.error}
              onRetry={() => { void list.refetch(); }}
              errorMessage={t("posTx.loadFailed")}
              emptyTitle={t("posTx.empty")}
              emptyBody={t("posTx.emptyBody")}
              page={data && {
                page: data.page, totalPages: data.total_pages, total: data.total,
                onPage: filters.setPage,
                perPage: filters.perPage, onPerPage: filters.setPerPage,
              }}
              exportCsv={{
                filename: `pos-transactions-${listQuery.start}-to-${listQuery.end}`,
                fetchPage: (page, perPage) => fetchPosTransactionsPage({ ...listQuery, page, perPage }),
              }}
            />
        </ReceiptSplit>
      </Card>
    </PageShell>
  );
}
