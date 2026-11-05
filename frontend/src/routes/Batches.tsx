import { useNavigate } from "react-router-dom";

import {
  BATCH_STATUS_TONES,
  batchStatusLabel,
  useBatches,
  type BatchRow,
  type BatchSort,
} from "../api/batches";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  ButtonLink, Card, DataTable, Empty, PageHeader, PageShell, Pill,
  type DataColumn,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "./Batches.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { navWord } from "../i18n/navWords";
import { tn, useT, type Translate } from "../i18n";

// Read-only ACH batches list at /app/batches. Sort by clicking
// column headers (URL-driven). Variance cell colored red when
// the batch under-paid the transfer ledger, green when matched/
// over-paid.
//
// Create / edit / link-transfers stays on the legacy Jinja
// /batches/* routes until subsequent PRs migrate them.

// Built during render so the headings follow the language.
function batchColumns(t: Translate): DataColumn<BatchRow>[] {
  return [
  {
    key: "date", header: t("transfer.date"), sortKey: "ach_date", sortFirst: "desc",
    render: (r) => <span className={styles.monoMuted}>{r.ach_date}</span>,
  },
  { key: "company", header: t("transfer.company"), sortKey: "company", render: (r) => r.company },
  {
    key: "ref", header: t("batch.reference"), sortKey: "batch_ref",
    render: (r) => <span className={styles.mono}>{r.batch_ref}</span>,
  },
  {
    key: "amount", header: t("batch.achAmount"), align: "right", sortKey: "ach_amount", sortFirst: "desc",
    render: (r) => <span className={styles.mono}>{fmtMoney2(r.ach_amount)}</span>,
  },
  {
    key: "transfers", header: t("batch.transfers"),
    render: (r) => (
      <span>
        <span className={styles.mono}>{fmtMoney2(r.transfers_total)}</span>
        <span className={styles.transferCount}>({fmtNumber(r.transfer_count)})</span>
        {r.card_credit > 0 && (
          <span className={styles.cardCredit}>
            {t("batch.cardCreditInline", { amount: fmtMoney2(-r.card_credit) })}
          </span>
        )}
        {r.payout_credit > 0 && (
          <span className={styles.cardCredit}>
            {t("batch.payoutCreditInline", { amount: fmtMoney2(-r.payout_credit) })}
          </span>
        )}
      </span>
    ),
  },
  {
    key: "variance", header: t("batch.variance"),
    render: (r) => (
      <span className={r.variance < 0 ? styles.varianceNeg : styles.variancePos}>
        {r.variance >= 0 ? "+" : ""}{fmtMoney2(r.variance)}
      </span>
    ),
  },
  {
    key: "status", header: t("transfer.status"), sortKey: "status",
    render: (r) => <Pill tone={BATCH_STATUS_TONES[r.status] ?? "neutral"}>{batchStatusLabel(r.status)}</Pill>,
  },
  ];
}

export default function Batches() {
  const t = useT();
  const columns = batchColumns(t);
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
        <PageHeader title={navWord("ACH batches")} />
        <Empty>{t("batch.listSignIn")}</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("ACH batches")}
        subtitle={data ? tn("batch.count", total, fmtNumber) : "—"}
        actions={(
          <ButtonLink to="/batches/new" tone="primary" size="sm">
            {t("batch.newButton")}
          </ButtonLink>
        )}
      />

      <Card>
        <DataTable
          columns={columns}
          rows={data?.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/batches/${r.id}/edit`)}
          rowLabel={(r) => t("batch.open", { ref: r.batch_ref })}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={t("batch.empty")}
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
