import { useNavigate } from "react-router-dom";

import {
  useTransfers,
  type TransferRow,
} from "../api/transfers";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { fmtMoney2, fmtCount } from "../lib/formatters";
import {
  ButtonLink, Card, DataTable, DateInput, Empty, Field, Input,
  PageHeader, PageShell, Pill, Select, type DataColumn,
} from "../components/ui";
import styles from "./Transfers.module.css";
import { formatTime } from "../lib/datetime";
import TransferKindPill from "../components/TransferKindPill";
import { SERVICES, isPayout } from "../lib/transferKinds";
import { PageCrumbs } from "../components/PageCrumbs";

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

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "Sent", label: "Sent" },
  { value: "Pending", label: "Pending" },
  { value: "Cancelled", label: "Cancelled" },
  { value: "Returned", label: "Returned" },
];

const SERVICE_OPTIONS = [
  { value: "", label: "All services" },
  ...SERVICES.map((s) => ({ value: s, label: s })),
];

const PAID_BY_OPTIONS = [
  { value: "", label: "Cash or card" },
  { value: "cash", label: "Cash" },
  { value: "debit_card", label: "Debit card" },
];

export default function Transfers() {
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
  const apiQuery = useTransfers({
    page, perPage: filters.perPage,
    sort: filters.sort?.key, dir: filters.sort?.direction,
    q: q.length >= 2 ? q : undefined,
    date_from: dateFrom || undefined,
    date_to:   dateTo || undefined,
    status:    status || undefined,
    service:   service || undefined,
    paid_by:   paidBy || undefined,
    pollMs: isTypingQuery ? 0 : POLL_INTERVAL_MS,
  });

  function setFilter(key: string, value: string) {
    setParam(key as keyof typeof params, value);
  }

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title="Transfers" />
        <Empty>
          Sign in as a store admin to view this store's transfers.
          Owner umbrellas + superadmin store-picker land in a
          follow-up PR.
        </Empty>
      </PageShell>
    );
  }

  const { data, dataUpdatedAt, isLoading, isFetching, isError, error, refetch } = apiQuery;

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title="Transfers"
        subtitle={data
          ? `${fmtCount(data.total, "transfer")}`
          : "—"}
        actions={(
          <div className={styles.headerActions}>
            {data && dataUpdatedAt > 0 && (
              <Pill tone="accent">
                {isFetching ? "Syncing…" : `Live · synced ${formatSyncTime(dataUpdatedAt)}`}
              </Pill>
            )}
            <ButtonLink to="/transfers/new" tone="primary" size="sm"> 
              + New transfer
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
          columns={TRANSFER_COLUMNS}
          rows={data?.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/transfers/${r.id}`)}
          rowLabel={(r) => `Open transfer from ${r.sender_name}`}
          emptyTitle="No transfers match these filters."
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
  return (
    <Card className="ds-filter-bar">
      <Field label="Search">
        <Input
          type="search"
          value={q}
          onChange={(e) => onQChange(e.target.value)}
          placeholder="sender, recipient, confirm #, country, batch"
        />
      </Field>
      <Field label="From">
        <DateInput
          value={dateFrom}
          onChange={(e) => onSet("date_from", e.target.value)}
        />
      </Field>
      <Field label="To">
        <DateInput
          value={dateTo}
          onChange={(e) => onSet("date_to", e.target.value)}
        />
      </Field>
      <Field label="Status">
        <Select
          value={status}
          onChange={(e) => onSet("status", e.target.value)}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </Select>
      </Field>
      <Field label="Service">
        <Select
          value={service}
          onChange={(e) => onSet("service", e.target.value)}
        >
          {SERVICE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </Select>
      </Field>
      <Field label="Paid by">
        <Select
          value={paidBy}
          onChange={(e) => onSet("paid_by", e.target.value)}
        >
          {PAID_BY_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </Select>
      </Field>
      {/* Subtle in-flight indicator without shifting layout. */}
      {busy && <span className={styles.filterBusy}>Updating…</span>}
    </Card>
  );
}

const TRANSFER_COLUMNS: DataColumn<TransferRow>[] = [
  { key: "date", header: "Date", sortKey: "date", sortFirst: "desc",
    render: (r) => <span className={styles.monoMuted}>{r.send_date}</span> },
  { key: "company", header: "Company", sortKey: "company", render: (r) => r.company },
  { key: "sender", header: "Sender", sortKey: "sender", render: (r) => r.sender_name },
  { key: "recipient", header: "Recipient", sortKey: "recipient", render: (r) => r.recipient_name || "—" },
  { key: "country", header: "Country", sortKey: "country", render: (r) => r.country || "—" },
  { key: "confirm", header: "Confirmation #", sortKey: "confirm",
    render: (r) => <span className={styles.monoMuted}>{r.confirm_number || "—"}</span> },
  { key: "status", header: "Status", sortKey: "status", render: (r) => r.status },
  { key: "total", header: "Total", align: "right", sortKey: "total", sortFirst: "desc",
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
    ) },
];


// Format the TanStack Query `dataUpdatedAt` timestamp for the
// header's "Live · synced HH:MM" pill. Below 60s shows as "just
// now" so a tight polling cycle doesn't churn through "synced
// 0:00 PM" updates every second.
function formatSyncTime(ms: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  return formatTime(new Date(ms));
}
