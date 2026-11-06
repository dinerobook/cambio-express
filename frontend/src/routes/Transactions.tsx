import { useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  fetchPosTransactionsPage, ticketKindLabel, useTransactions, type PosTransactionRow,
} from "../api/posimport";
import { csvMoney } from "../lib/csv";
import { AppLink,
  Card, Checkbox, DataTable, DateInput, Field, InfoTip,
  Input, KpiCard, KpiGrid, PageHeader, PageShell, Pill,
  Section, Select, tokens, type DataColumn,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { csvTimestamp, daysAgoIso, formatTimestamp } from "../lib/datetime";
import styles from "./Transactions.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/transactions (G-6) — every register ticket, searchable.
//
// The register has always sent this detail; until now it was rolled
// into day totals and the ticket itself was unreachable. An owner
// asking "what sold on this transaction?" or "which tickets had an
// item voided?" gets answered here.
//
// A voided ticket is FLAGGED, not hidden: the whole reason to open
// this screen is to see the void. Its money is already excluded
// server-side, so the totals below never include one.

const KINDS: { value: string; label: MessageKey }[] = [
  { value: "", label: "posTx.allKinds" },
  { value: "sale", label: "posTx.kindSales" },
  { value: "refund", label: "posTx.kindRefunds" },
  { value: "void", label: "posTx.kindVoided" },
  { value: "financial", label: "posTx.kindFinancial" },
  { value: "other", label: "posTx.kindOther" },
];

const MONO = { fontFamily: tokens.fontMono };

// Built during render so the headings follow a language switch.
const columns = (): DataColumn<PosTransactionRow>[] => [
  {
    key: "time", header: t("posTx.colTime"),
    render: (r) => (r.receipt_at ? formatTimestamp(r.receipt_at) : r.business_date),
    csv: (r) => (r.receipt_at ? csvTimestamp(r.receipt_at) : r.business_date),
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
  { key: "cashier", header: t("posTx.colCashier"), render: (r) => r.cashier_id || "—", csv: (r) => r.cashier_id },
  { key: "items", header: t("posTx.colItems"), align: "right", render: (r) => <span style={MONO}>{r.item_count}</span>,
    csv: (r) => r.item_count },
  { key: "tax", header: t("posTx.colTax"), align: "right", render: (r) => <span style={MONO}>{fmtMoney2(r.tax)}</span>,
    csv: (r) => csvMoney(r.tax) },
  { key: "total", header: t("posTx.colTotal"), align: "right", render: (r) => <span style={MONO}>{fmtMoney2(r.grand_total)}</span>,
    csv: (r) => csvMoney(r.grand_total) },
  {
    key: "flags", header: "", label: "", csvHeader: t("posTx.colFlags"),
    csv: (r) => [
      r.kind && r.kind !== "sale" ? ticketKindLabel(r.kind) : "",
      r.has_voided_line ? t("posTx.voidedItem") : "",
      r.training_mode ? t("posTx.training") : "",
      r.offline ? t("posTx.offline") : "",
      r.suspended ? t("posTx.suspended") : "",
    ].filter(Boolean).join("; "),
    render: (r) => (
      <div className={styles.flags}>
        {r.kind && r.kind !== "sale" && <Pill tone="neutral">{ticketKindLabel(r.kind)}</Pill>}
        {r.has_voided_line && <Pill tone="warning">{t("posTx.voidedItem")}</Pill>}
        {r.training_mode && <Pill tone="neutral">{t("posTx.training")}</Pill>}
        {r.offline && <Pill tone="warning">{t("posTx.offline")}</Pill>}
        {r.suspended && <Pill tone="warning">{t("posTx.suspended")}</Pill>}
      </div>
    ),
  },
];

export default function Transactions() {
  useT(); // re-render on a language switch
  const navigate = useNavigate();
  const [defaults] = useState(() => ({ start: daysAgoIso(6), end: daysAgoIso(0) }));
  const filters = useUrlFilterState({
    q: "", kind: "", voided: "",
    start: defaults.start, end: defaults.end,
  }, { pageSizeKey: "pos-transactions" });
  const listQuery = {
    start: filters.params.start,
    end: filters.params.end,
    q: filters.params.q,
    kind: filters.params.kind,
    voidedOnly: filters.params.voided === "1",
  };
  const list = useTransactions({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const data = list.data;

  return (
    <PageShell maxWidth="76rem">
      <PageCrumbs />
      <PageHeader
        title={
          <>
            {navWord("Transactions")}
            <InfoTip text={t("posTx.tip")} />
          </>
        }
        subtitle={t("posTx.subtitle")}
      />

      <div className={styles.filters}>
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
        <Field label={t("posTx.kind")}>
          <Select
            value={filters.params.kind}
            onChange={(e) => filters.setParam("kind", e.target.value)}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{t(k.label)}</option>
            ))}
          </Select>
        </Field>
        <div className={styles.searchField}>
          <Field label={t("posTx.search")}>
            <Input
              type="search"
              placeholder={t("posTx.searchPlaceholder")}
              value={filters.draft.q ?? filters.params.q}
              onChange={(e) => filters.debounced("q", e.target.value)}
            />
          </Field>
        </div>
        <div className={styles.voidedToggle}>
          <Checkbox
            checked={filters.params.voided === "1"}
            onChange={(checked) =>
              filters.setParam("voided", checked ? "1" : "")}
          >
            {t("posTx.voidedOnly")}
          </Checkbox>
        </div>
      </div>

      {data && (
        <KpiGrid>
          <KpiCard
            label={t("posTx.tickets")}
            value={fmtNumber(data.total)}
            sub={`${filters.params.start} → ${filters.params.end}`}
          />
          <KpiCard
            label={t("posTx.totalRung")}
            value={fmtMoney2(data.total_grand)}
            tone="positive"
          />
          <KpiCard
            label={t("posTx.withVoided")}
            value={fmtNumber(data.voided_count)}
            tone={data.voided_count > 0 ? "warning" : "positive"}
          />
        </KpiGrid>
      )}

      <Section title={t("posTx.tickets")}>
        <Card>
          <DataTable
            columns={columns()}
            rows={data?.rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/transactions/${r.id}`)}
            rowLabel={(r) => t("posTx.openTicket", { ticket: r.transaction_no || r.id })}
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
        </Card>
      </Section>
    </PageShell>
  );
}
