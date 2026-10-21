import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useTransactions, type PosTransactionRow } from "../api/posimport";
import { AppLink,
  Card, Checkbox, DataTable, DateInput, Field, InfoTip,
  Input, KpiCard, KpiGrid, PageHeader, PageShell, Pill,
  Section, Select, tokens, type DataColumn,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { daysAgoIso, formatTimestamp } from "../lib/datetime";
import styles from "./Transactions.module.css";
import { PageCrumbs } from "../components/PageCrumbs";

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

const KINDS = [
  { value: "", label: "All kinds" },
  { value: "sale", label: "Sales" },
  { value: "refund", label: "Refunds" },
  { value: "void", label: "Voided tickets" },
  { value: "financial", label: "Financial" },
  { value: "other", label: "Other" },
];

const MONO = { fontFamily: tokens.fontMono };

const COLUMNS: DataColumn<PosTransactionRow>[] = [
  {
    key: "time", header: "Time",
    render: (t) => (t.receipt_at ? formatTimestamp(t.receipt_at) : t.business_date),
  },
  {
    key: "ticket", header: "Ticket",
    render: (t) => (
      <AppLink to={`/transactions/${t.id}`} className="ds-link" style={MONO}>
        {t.transaction_no || `#${t.id}`}
      </AppLink>
    ),
  },
  { key: "register", header: "Register", render: (t) => t.register_id || "—" },
  { key: "cashier", header: "Cashier", render: (t) => t.cashier_id || "—" },
  { key: "items", header: "Items", align: "right", render: (t) => <span style={MONO}>{t.item_count}</span> },
  { key: "tax", header: "Tax", align: "right", render: (t) => <span style={MONO}>{fmtMoney2(t.tax)}</span> },
  { key: "total", header: "Total", align: "right", render: (t) => <span style={MONO}>{fmtMoney2(t.grand_total)}</span> },
  {
    key: "flags", header: "", label: "",
    render: (t) => (
      <div className={styles.flags}>
        {t.kind && t.kind !== "sale" && <Pill tone="neutral">{t.kind}</Pill>}
        {t.has_voided_line && <Pill tone="warning">voided item</Pill>}
        {t.training_mode && <Pill tone="neutral">training</Pill>}
        {t.offline && <Pill tone="warning">offline</Pill>}
        {t.suspended && <Pill tone="warning">suspended</Pill>}
      </div>
    ),
  },
];

export default function Transactions() {
  const navigate = useNavigate();
  const [defaults] = useState(() => ({ start: daysAgoIso(6), end: daysAgoIso(0) }));
  const filters = useUrlFilterState({
    q: "", kind: "", voided: "",
    start: defaults.start, end: defaults.end,
  }, { pageSizeKey: "pos-transactions" });
  const list = useTransactions({
    start: filters.params.start,
    end: filters.params.end,
    q: filters.params.q,
    kind: filters.params.kind,
    voidedOnly: filters.params.voided === "1",
    page: filters.page,
    perPage: filters.perPage,
  });
  const data = list.data;

  return (
    <PageShell maxWidth="76rem">
      <PageCrumbs />
      <PageHeader
        title={
          <>
            Transactions
            <InfoTip text="Every ticket your register rang, with what was on it. Tickets appear as business days are booked from the register's journal files. A ticket with a voided item is flagged — the void is shown on the ticket, and never counted in any total." />
          </>
        }
        subtitle="Search a ticket, or find the ones with a void."
      />

      <div className={styles.filters}>
        <Field label="From">
          <DateInput
            value={filters.params.start}
            onChange={(e) => filters.setParam("start", e.target.value)}
          />
        </Field>
        <Field label="To">
          <DateInput
            value={filters.params.end}
            onChange={(e) => filters.setParam("end", e.target.value)}
          />
        </Field>
        <Field label="Kind">
          <Select
            value={filters.params.kind}
            onChange={(e) => filters.setParam("kind", e.target.value)}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </Select>
        </Field>
        <div className={styles.searchField}>
          <Field label="Search">
            <Input
              type="search"
              placeholder="Ticket number, cashier, or item…"
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
            Voided items only
          </Checkbox>
        </div>
      </div>

      {data && (
        <KpiGrid>
          <KpiCard
            label="Tickets"
            value={fmtNumber(data.total)}
            sub={`${filters.params.start} → ${filters.params.end}`}
          />
          <KpiCard
            label="Total rung"
            value={fmtMoney2(data.total_grand)}
            tone="positive"
          />
          <KpiCard
            label="With a voided item"
            value={fmtNumber(data.voided_count)}
            tone={data.voided_count > 0 ? "warning" : "positive"}
          />
        </KpiGrid>
      )}

      <Section title="Tickets">
        <Card>
          <DataTable
            columns={COLUMNS}
            rows={data?.rows}
            rowKey={(t) => t.id}
            onRowClick={(t) => navigate(`/transactions/${t.id}`)}
            rowLabel={(t) => `Open ticket ${t.transaction_no || t.id}`}
            isLoading={list.isLoading} isError={list.isError} error={list.error}
            onRetry={() => { void list.refetch(); }}
            errorMessage="Could not load transactions."
            emptyTitle="No transactions in this range"
            emptyBody="Tickets appear as business days are booked from your register journals. Check the range, or set up the site agent under Register import."
            page={data && {
              page: data.page, totalPages: data.total_pages, total: data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
          />
        </Card>
      </Section>
    </PageShell>
  );
}
