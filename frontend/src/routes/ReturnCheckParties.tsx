import { useNavigate } from "react-router-dom";

import {
  fetchReturnCheckPartiesPage, useReturnCheckParties,
  type PartyKind, type ReturnCheckPartyRow,
} from "../api/returnChecks";
import { csvMoney } from "../lib/csv";
import { csvDate, formatDate } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  Card, DataTable, DateInput, Field, Input, PageShell, type DataColumn,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { ReturnChecksHeader } from "../components/ReturnChecksHeader";
import styles from "./ReturnChecks.module.css";
import { tn, useT, type Translate } from "../i18n";

// By company / By customer: who returns checks, how often and how
// much — worked out live from the store's returned checks, with
// names grouped even when typed a little differently ("ACME Inc." =
// "acme inc"). A row opens that company's or customer's checks.

function partyColumns(t: Translate, by: PartyKind): DataColumn<ReturnCheckPartyRow>[] {
  return [
    {
      key: "name", header: by === "company" ? t("returnCheck.company") : t("transfer.customer"),
      sortKey: "name", sortFirst: "asc",
      render: (r) => (
        <span>
          {r.name}
          {r.routing_number && (
            <span className={styles.paymentCount}>{r.routing_number}</span>
          )}
        </span>
      ),
      csv: (r) => r.name,
    },
    {
      key: "checks", header: t("returnCheck.checks"), align: "right", sortKey: "checks", sortFirst: "desc",
      render: (r) => <span className={styles.mono}>{fmtNumber(r.check_count)}</span>,
      csv: (r) => r.check_count,
    },
    {
      key: "amount", header: t("returnCheck.amountReturned"), align: "right", sortKey: "amount", sortFirst: "desc",
      render: (r) => <span className={styles.mono}>{fmtMoney2(r.amount_total)}</span>,
      csv: (r) => csvMoney(r.amount_total),
    },
    {
      key: "owed", header: t("returnCheck.stillOwed"), align: "right", sortKey: "owed", sortFirst: "desc",
      render: (r) => (
        <span className={styles.mono}>
          {r.open_count > 0 ? fmtMoney2(r.owed_total) : "—"}
          {r.open_count > 0 && (
            <span className={styles.paymentCount}>({fmtNumber(r.open_count)})</span>
          )}
        </span>
      ),
      csv: (r) => csvMoney(r.owed_total),
    },
    {
      key: "lost", header: t("returnCheck.writtenOff"), align: "right", sortKey: "lost", sortFirst: "desc",
      render: (r) => (
        <span className={styles.mono}>
          {r.lost_count > 0 ? fmtMoney2(r.lost_total) : "—"}
          {r.lost_count > 0 && (
            <span className={styles.paymentCount}>({fmtNumber(r.lost_count)})</span>
          )}
        </span>
      ),
      csv: (r) => csvMoney(r.lost_total),
    },
    {
      key: "last", header: t("returnCheck.lastReturned"), sortKey: "last", sortFirst: "desc",
      render: (r) => <span className={styles.monoMuted}>{formatDate(r.last_returned_on)}</span>,
      csv: (r) => csvDate(r.last_returned_on),
    },
  ];
}

export default function ReturnCheckParties({ by }: { by: PartyKind }) {
  const t = useT();
  const navigate = useNavigate();
  const filters = useUrlFilterState({ q: "", from: "", to: "" }, {
    pageSizeKey: `return-check-${by}`,
    defaultSort: { key: "checks", direction: "desc" },
  });
  const { q, from, to } = filters.params;
  const listQuery = {
    by, q, from, to, sort: filters.sort?.key, dir: filters.sort?.direction,
  };
  const { data, isLoading, isError, error, refetch } = useReturnCheckParties({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });

  return (
    <PageShell>
      <ReturnChecksHeader
        subtitle={data
          ? tn(by === "company" ? "returnCheck.companyCount" : "returnCheck.customerCount",
              data.total, fmtNumber)
          : "—"}
      />
      <Card className="ds-filter-bar">
        <Field label={t("transfer.search")}>
          <Input
            type="search"
            value={filters.draft.q ?? q}
            onChange={(e) => filters.debounced("q", e.target.value)}
            placeholder={by === "company"
              ? t("returnCheck.companySearchPlaceholder")
              : t("returnCheck.customerSearchPlaceholder")}
          />
        </Field>
        <Field label={t("returnCheck.returnedFrom")}>
          <DateInput value={from} onChange={(e) => filters.setParam("from", e.target.value)} />
        </Field>
        <Field label={t("returnCheck.returnedTo")}>
          <DateInput value={to} onChange={(e) => filters.setParam("to", e.target.value)} />
        </Field>
      </Card>
      <Card>
        <DataTable
          columns={partyColumns(t, by)}
          rows={data?.rows}
          rowKey={(r) => r.key}
          onRowClick={(r) => navigate(
            `/return-checks?${new URLSearchParams({ [by]: r.key }).toString()}`,
          )}
          rowLabel={(r) => t("returnCheck.openPartyChecks", { name: r.name })}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={q || from || to ? t("returnCheck.noMatches") : t("returnCheck.empty")}
          sort={filters.sort}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: by === "company" ? "returned-checks-by-company" : "returned-checks-by-customer",
            fetchPage: (page, perPage) => fetchReturnCheckPartiesPage({ ...listQuery, page, perPage }),
          }}
        />
      </Card>
    </PageShell>
  );
}
