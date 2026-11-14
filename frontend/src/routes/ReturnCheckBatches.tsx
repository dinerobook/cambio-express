import { useNavigate } from "react-router-dom";

import {
  batchName, fetchReturnCheckBatchesPage, useReturnCheckBatches,
  type ReturnCheckBatchRow,
} from "../api/returnChecks";
import { csvMoney } from "../lib/csv";
import { csvDate, formatDate } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  Card, DataTable, Field, Input, PageShell, Pill, type DataColumn,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { ReturnChecksHeader } from "../components/ReturnChecksHeader";
import styles from "./ReturnChecks.module.css";
import { tn, useT, type Translate } from "../i18n";

// The Batches view of Returned checks: each return notice the bank
// sent, with how many checks came back in it, their total and how
// much has been recovered. Opens the batch page.

function batchColumns(t: Translate): DataColumn<ReturnCheckBatchRow>[] {
  return [
    {
      key: "returned", header: t("returnCheck.returnedOn"), sortKey: "returned", sortFirst: "desc",
      render: (r) => <span className={styles.monoMuted}>{formatDate(r.returned_on)}</span>,
      csv: (r) => csvDate(r.returned_on),
    },
    {
      key: "reference", header: t("returnCheck.reference"), sortKey: "reference",
      render: (r) => <span className={styles.mono}>{r.reference || "—"}</span>,
      csv: (r) => r.reference,
    },
    {
      key: "companies", header: t("returnCheck.tabCompanies"),
      render: (r) => r.companies.join(", ") || "—",
      csv: (r) => r.companies.join(", "),
    },
    {
      key: "checks", header: t("returnCheck.checks"), align: "right",
      render: (r) => <span className={styles.mono}>{fmtNumber(r.check_count)}</span>,
      csv: (r) => r.check_count,
    },
    {
      key: "amount", header: t("dash.amount"), align: "right",
      render: (r) => <span className={styles.mono}>{fmtMoney2(r.amount_total)}</span>,
      csv: (r) => csvMoney(r.amount_total),
    },
    {
      key: "recovered", header: t("returnCheck.statusRecovered"), align: "right",
      render: (r) => <span className={styles.mono}>{fmtMoney2(r.recovered_total)}</span>,
      csv: (r) => csvMoney(r.recovered_total),
    },
    {
      key: "open", header: t("returnCheck.open"), align: "right",
      render: (r) => r.open_count > 0
        ? <Pill tone="warning">{tn("returnCheck.openCount", r.open_count, fmtNumber)}</Pill>
        : <Pill tone="success">{t("returnCheck.allClosed")}</Pill>,
      csv: (r) => r.open_count,
    },
  ];
}

export default function ReturnCheckBatches() {
  const t = useT();
  const navigate = useNavigate();
  const filters = useUrlFilterState({ q: "" }, {
    pageSizeKey: "return-check-batches",
    defaultSort: { key: "returned", direction: "desc" },
  });
  const listQuery = {
    q: filters.params.q, sort: filters.sort?.key, dir: filters.sort?.direction,
  };
  const { data, isLoading, isError, error, refetch } = useReturnCheckBatches({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });

  return (
    <PageShell>
      <ReturnChecksHeader
        subtitle={data ? tn("returnCheck.batchCount", data.total, fmtNumber) : "—"}
      />
      <Card className="ds-filter-bar">
        <Field label={t("transfer.search")}>
          <Input
            type="search"
            value={filters.draft.q ?? filters.params.q}
            onChange={(e) => filters.debounced("q", e.target.value)}
            placeholder={t("returnCheck.batchSearchPlaceholder")}
          />
        </Field>
      </Card>
      <Card>
        <DataTable
          columns={batchColumns(t)}
          rows={data?.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/return-checks/batches/${r.id}`)}
          rowLabel={(r) => t("returnCheck.openBatch", { name: batchName(r, formatDate) })}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={filters.params.q ? t("returnCheck.noMatches") : t("returnCheck.noBatches")}
          emptyBody={filters.params.q ? undefined : t("returnCheck.noBatchesBody")}
          sort={filters.sort}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "returned-check-batches",
            fetchPage: (page, perPage) => fetchReturnCheckBatchesPage({ ...listQuery, page, perPage }),
          }}
        />
      </Card>
    </PageShell>
  );
}
