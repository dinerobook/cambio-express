import { useNavigate } from "react-router-dom";

import {
  BATCH_STATUS_TONES,
  useBatches,
  type BatchRow,
  type BatchSort,
} from "../api/batches";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney2 } from "../lib/formatters";
import {
  Breadcrumbs,
  ButtonLink, Card, DataTable, Empty, PageHeader, PageShell, Pill,
  type DataColumn,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "./Batches.module.css";

// Read-only ACH batches list at /app/batches. Sort by clicking
// column headers (URL-driven). Variance cell colored red when
// the batch under-paid the transfer ledger, green when matched/
// over-paid.
//
// Create / edit / link-transfers stays on the legacy Jinja
// /batches/* routes until subsequent PRs migrate them.

const COLUMNS: DataColumn<BatchRow>[] = [
  {
    key: "date", header: "Date", sortKey: "ach_date", sortFirst: "desc",
    render: (r) => <span className={styles.monoMuted}>{r.ach_date}</span>,
  },
  { key: "company", header: "Company", sortKey: "company", render: (r) => r.company },
  {
    key: "ref", header: "Reference", sortKey: "batch_ref",
    render: (r) => <span className={styles.mono}>{r.batch_ref}</span>,
  },
  {
    key: "amount", header: "ACH amount", align: "right", sortKey: "ach_amount", sortFirst: "desc",
    render: (r) => <span className={styles.mono}>{fmtMoney2(r.ach_amount)}</span>,
  },
  {
    key: "transfers", header: "Transfers",
    render: (r) => (
      <span>
        <span className={styles.mono}>{fmtMoney2(r.transfers_total)}</span>
        <span className={styles.transferCount}>({r.transfer_count})</span>
        {r.card_credit > 0 && (
          <span className={styles.cardCredit}>
            {fmtMoney2(-r.card_credit)} debit card credit
          </span>
        )}
        {r.payout_credit > 0 && (
          <span className={styles.cardCredit}>
            {fmtMoney2(-r.payout_credit)} payout credit
          </span>
        )}
      </span>
    ),
  },
  {
    key: "variance", header: "Variance",
    render: (r) => (
      <span className={r.variance < 0 ? styles.varianceNeg : styles.variancePos}>
        {r.variance >= 0 ? "+" : ""}{fmtMoney2(r.variance)}
      </span>
    ),
  },
  {
    key: "status", header: "Status", sortKey: "status",
    render: (r) => <Pill tone={BATCH_STATUS_TONES[r.status] ?? "neutral"}>{r.status}</Pill>,
  },
];

export default function Batches() {
  const identity = getCurrentIdentity();
  const navigate = useNavigate();
  const filters = useUrlFilterState({}, {
    pageSizeKey: "batches",
    defaultSort: { key: "ach_date", direction: "desc" },
  });
  const sort = filters.sort!;
  const { data, isLoading, isError, error, refetch } = useBatches({
    sort: sort.key as BatchSort,
    direction: sort.direction,
    page: filters.page,
    perPage: filters.perPage,
  });

  const total = data?.total ?? data?.rows?.length ?? 0;

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageHeader title="ACH batches" />
        <Empty>Sign in as a store admin to view ACH batches.</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>

      <Breadcrumbs crumbs={[{ label: "ACH Batches" }]} />

      <PageHeader
        title="ACH batches"
        subtitle={data ? `${total.toLocaleString()} ${total === 1 ? "batch" : "batches"}` : "—"}
        actions={(
          <ButtonLink href="/batches/new" tone="primary" size="sm">
            + New batch
          </ButtonLink>
        )}
      />

      <Card>
        <DataTable
          columns={COLUMNS}
          rows={data?.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/batches/${r.id}/edit`)}
          rowLabel={(r) => `Open batch ${r.batch_ref}`}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle="No ACH batches yet."
          sort={sort}
          page={data && {
            page: data.page ?? 1, totalPages: data.total_pages ?? 1, total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
        />
      </Card>
    </PageShell>
  );
}
