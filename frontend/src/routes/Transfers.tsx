import { useNavigate } from "react-router-dom";

import {
  fetchTransfersPage,
  useTransfers,
  type TransferRow,
} from "../api/transfers";
import { csvMoney } from "../lib/csv";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  ButtonLink, Card, DataTable, DateInput, Empty, Field, Input,
  PageHeader, PageShell, Pill, Select, type CsvColumn, type DataColumn,
} from "../components/ui";
import styles from "./Transfers.module.css";
import { formatTime } from "../lib/datetime";
import TransferKindPill from "../components/TransferKindPill";
import {
  SERVICES, STATUSES, isPayout, serviceLabel, statusLabel,
} from "../lib/transferKinds";
import { PageCrumbs } from "../components/PageCrumbs";
import { navWord } from "../i18n/navWords";
import { t, tn, useT, type Translate } from "../i18n";

// Poll the transfers list this often so two cashiers sharing one
// employee login on different machines see each other's edits
// without a manual refresh. Foreground only — TanStack Query
// pauses the timer when the tab is hidden so we don't burn
// bandwidth in a background tab.
const POLL_INTERVAL_MS = 20_000;

// Full transfers list page at /app/transfers.
//
// Mirrors the legacy /transfers Jinja page's UX: live-search box
// (debounced 300ms, 2-char minimum per CLAUDE.md), date-range
// filters, status dropdown, paginated table. URL query string
// holds the active filter state so deep-linking + back-button
// behave correctly.
//
// The actual API call is `useTransfers` from src/api/transfers —
// same controller as the dashboard's recent-transfers card, just
// with full filters + pagination wired up.

// Filter values are what the API filters on (English); the option
// text is in the person's language. Built during render so a language
// change re-reads them.
function filterOptions(t: Translate) {
  return {
    status: [
      { value: "", text: t("transfer.allStatuses") },
      ...STATUSES.map((s) => ({ value: s, text: statusLabel(s) })),
    ],
    service: [
      { value: "", text: t("transfer.allServices") },
      ...SERVICES.map((s) => ({ value: s, text: serviceLabel(s) })),
    ],
    paidBy: [
      { value: "", text: t("transfer.cashOrCard") },
      { value: "cash", text: t("transfer.cash") },
      { value: "debit_card", text: t("transfer.debitCard") },
    ],
  };
}

export default function Transfers() {
  const t = useT();
  // Built each render (cheap), so a language switch re-reads them.
  const columns = transferColumns(t);
  const identity = getCurrentIdentity();
  const filters = useUrlFilterState({
    q: "",
    date_from: "",
    date_to: "",
    status: "",
    service: "",
    paid_by: "",
  }, {
    pageSizeKey: "transfers",
    defaultSort: { key: "date", direction: "desc" },
  });
  const navigate = useNavigate();
  const { params, page, setParam, setPage, draft } = filters;
  const q = params.q;
  const dateFrom = params.date_from;
  const dateTo = params.date_to;
  const status = params.status;
  const service = params.service;
  const paidBy = params.paid_by;

  // Pause polling while a debounced search is in flight so we don't
  // fire two queries back-to-back (one when the URL updates, one
  // from the next poll). draft.q !== undefined means a pending edit.
  const isTypingQuery = draft.q !== undefined && draft.q !== q;
  // The list's filters and sort; the CSV export asks for the same.
  const listQuery = {
    sort: filters.sort?.key, dir: filters.sort?.direction,
    q: q.length >= 2 ? q : undefined,
    date_from: dateFrom || undefined,
    date_to:   dateTo || undefined,
    status:    status || undefined,
    service:   service || undefined,
    paid_by:   paidBy || undefined,
  };
  const apiQuery = useTransfers({
    ...listQuery,
    page, perPage: filters.perPage,
    pollMs: isTypingQuery ? 0 : POLL_INTERVAL_MS,
  });

  function setFilter(key: string, value: string) {
    setParam(key as keyof typeof params, value);
  }

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title={navWord("Transfers")} />
        <Empty>{t("transfer.listSignIn")}</Empty>
      </PageShell>
    );
  }

  const { data, dataUpdatedAt, isLoading, isFetching, isError, error, refetch } = apiQuery;

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("Transfers")}
        subtitle={data ? tn("transfer.count", data.total, fmtNumber) : "—"}
        actions={(
          <div className={styles.headerActions}>
            {data && dataUpdatedAt > 0 && (
              <Pill tone="accent">
                {isFetching
                  ? t("transfer.syncing")
                  : t("transfer.liveSynced", { time: formatSyncTime(dataUpdatedAt) })}
              </Pill>
            )}
            <ButtonLink to="/transfers/new" tone="primary" size="sm">
              {t("transfer.newButton")}
            </ButtonLink>
          </div>
        )}
      />

      <FilterBar
        q={draft.q ?? q}
        onQChange={(v: string) => filters.debounced("q", v)}
        dateFrom={dateFrom}
        dateTo={dateTo}
        status={status}
        service={service}
        paidBy={paidBy}
        onSet={setFilter}
        busy={isFetching}
      />

      <Card>
        <DataTable
          columns={columns}
          rows={data?.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/transfers/${r.id}`)}
          rowLabel={(r) => t("transfer.openFrom", { name: r.sender_name })}
          emptyTitle={t("transfer.noMatches")}
          isLoading={isLoading}
          isError={isError}
          error={error}
          onRetry={() => { void refetch(); }}
          page={data && {
            page: data.page,
            totalPages: data.total_pages,
            total: data.total,
            onPage: setPage,
            perPage: filters.perPage,
            onPerPage: filters.setPerPage,
          }}
          sort={filters.sort}
          exportCsv={{
            filename: "transfers",
            fetchPage: (p, n) => fetchTransfersPage(
              identity.store_id as number, { ...listQuery, page: p, perPage: n },
            ),
            extraColumns: transferCsvExtras(t),
          }}
        />
      </Card>
    </PageShell>
  );
}

interface FilterBarProps {
  q: string;
  onQChange: (q: string) => void;
  dateFrom: string;
  dateTo: string;
  status: string;
  service: string;
  paidBy: string;
  onSet: (key: string, value: string) => void;
  busy: boolean;
}

function FilterBar({
  q, onQChange, dateFrom, dateTo, status, service, paidBy, onSet, busy,
}: FilterBarProps) {
  const t = useT();
  const options = filterOptions(t);
  return (
    <Card className="ds-filter-bar">
      <Field label={t("transfer.search")}>
        <Input
          type="search"
          value={q}
          onChange={(e) => onQChange(e.target.value)}
          placeholder={t("transfer.searchPlaceholder")}
        />
      </Field>
      <Field label={t("transfer.from")}>
        <DateInput
          value={dateFrom}
          onChange={(e) => onSet("date_from", e.target.value)}
        />
      </Field>
      <Field label={t("transfer.to")}>
        <DateInput
          value={dateTo}
          onChange={(e) => onSet("date_to", e.target.value)}
        />
      </Field>
      <Field label={t("transfer.status")}>
        <Select
          value={status}
          onChange={(e) => onSet("status", e.target.value)}
        >
          {options.status.map((s) => (
            <option key={s.value} value={s.value}>{s.text}</option>
          ))}
        </Select>
      </Field>
      <Field label={t("transfer.service")}>
        <Select
          value={service}
          onChange={(e) => onSet("service", e.target.value)}
        >
          {options.service.map((s) => (
            <option key={s.value} value={s.value}>{s.text}</option>
          ))}
        </Select>
      </Field>
      <Field label={t("transfer.paidBy")}>
        <Select
          value={paidBy}
          onChange={(e) => onSet("paid_by", e.target.value)}
        >
          {options.paidBy.map((s) => (
            <option key={s.value} value={s.value}>{s.text}</option>
          ))}
        </Select>
      </Field>
      {/* Subtle in-flight indicator without shifting layout. */}
      {busy && <span className={styles.filterBusy}>{t("transfer.updating")}</span>}
    </Card>
  );
}

function transferColumns(t: Translate): DataColumn<TransferRow>[] {
  return [
  { key: "date", header: t("transfer.date"), sortKey: "date", sortFirst: "desc",
    render: (r) => <span className={styles.monoMuted}>{r.send_date}</span>,
    csv: (r) => r.send_date },
  { key: "company", header: t("transfer.company"), sortKey: "company", render: (r) => r.company,
    csv: (r) => r.company },
  { key: "sender", header: t("transfer.sender"), sortKey: "sender", render: (r) => r.sender_name,
    csv: (r) => r.sender_name },
  { key: "recipient", header: t("transfer.recipient"), sortKey: "recipient", render: (r) => r.recipient_name || "—",
    csv: (r) => r.recipient_name },
  { key: "country", header: t("transfer.country"), sortKey: "country", render: (r) => r.country || "—",
    csv: (r) => r.country },
  { key: "confirm", header: t("transfer.confirmNumber"), sortKey: "confirm",
    render: (r) => <span className={styles.monoMuted}>{r.confirm_number || "—"}</span>,
    csv: (r) => r.confirm_number },
  { key: "status", header: t("transfer.status"), sortKey: "status", render: (r) => statusLabel(r.status),
    csv: (r) => statusLabel(r.status) },
  { key: "total", header: t("transfer.total"), align: "right", sortKey: "total", sortFirst: "desc",
    render: (r) => (
      <span className={styles.kindAmount}>
        <TransferKindPill
          serviceType={r.service_type}
          paymentMethod={r.payment_method}
        />
        {/* A payout is cash going out: shown as a negative. */}
        <span className={styles.mono}>
          {fmtMoney2(isPayout(r.service_type) ? -r.total_collected : r.total_collected)}
        </span>
      </span>
    ),
    csv: (r) => csvMoney(isPayout(r.service_type) ? -r.total_collected : r.total_collected) },
  ];
}

/** What the CSV carries beyond the columns: the parts of the total
 *  (Transfers INVARIANTS: total = send + fee + federal tax), how it
 *  was paid and who took it. */
function transferCsvExtras(t: Translate): CsvColumn<TransferRow>[] {
  return [
    { header: t("transfer.service"), csv: (r) => serviceLabel(r.service_type) },
    { header: t("transfer.paidBy"),
      csv: (r) => (r.payment_method === "debit_card" ? t("transfer.debitCard") : t("transfer.cash")) },
    { header: t("transfer.sendAmount"), csv: (r) => csvMoney(r.send_amount) },
    { header: t("transfer.fee"), csv: (r) => csvMoney(r.fee) },
    { header: t("transfer.federalTax"), csv: (r) => csvMoney(r.federal_tax) },
    { header: t("transfer.employee"), csv: (r) => r.employee_name },
  ];
}


// Format the TanStack Query `dataUpdatedAt` timestamp for the
// header's "Live · synced HH:MM" pill. Below 60s shows as "just
// now" so a tight polling cycle doesn't churn through "synced
// 0:00 PM" updates every second.
function formatSyncTime(ms: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("transfer.justNow");
  return formatTime(new Date(ms));
}
