import { useNavigate } from "react-router-dom";

import {
  BAD_CHECK_STATUS_TONES, CHECK_STATUS_TONES, checkStatusLabel, fetchChecksPage,
  useCheckReport, useChecks, type CashedCheckRow, type CheckListQuery,
} from "../api/checkCashing";
import { CheckTotalsGrid } from "../components/CheckTotals";
import { DeskPage, DeskPane } from "../components/DeskPage";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  Card, DataTable, DateInput, Empty, Field, Input, PageHeader, Pill,
  TabsBar, TabsButton, type DataColumn,
} from "../components/ui";
import { navWord } from "../i18n/navWords";
import { tn, useT, type MessageKey, type Translate } from "../i18n";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate, todayIso } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "./CheckCashing.module.css";

// Check cashing app → Checks (/app/check-cashing/checks). Every check
// brought to the counter at the owner's stores, today by default, with
// the day's summary on top. A row opens the customer, where a manager
// voids or marks a check bad.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("Checks and reports").

const STATUS_TABS: Array<{ slug: string; label: MessageKey }> = [
  { slug: "",         label: "checkCashing.all" },
  { slug: "cashed",   label: "checkCashing.checkCashed" },
  { slug: "declined", label: "checkCashing.checkDeclined" },
  { slug: "voided",   label: "checkCashing.checkVoided" },
];

function columns(t: Translate): DataColumn<CashedCheckRow>[] {
  return [
    {
      key: "day", header: t("checkCashing.colDay"),
      render: (r) => <span className={styles.mono}>{formatDate(r.store_day)}</span>,
      csv: (r) => r.store_day,
    },
    {
      key: "customer", header: t("checkCashing.colCustomer"),
      render: (r) => <span className={styles.name}>{r.customer_name}</span>,
      csv: (r) => r.customer_name,
    },
    {
      key: "company", header: t("checkCashing.colCompany"),
      render: (r) => (
        <span>
          {r.company_name}
          {r.check_number && <span className={styles.muted}> · #{r.check_number}</span>}
        </span>
      ),
      csv: (r) => r.company_name,
    },
    {
      key: "amount", header: t("checkCashing.colCheck"), align: "right",
      render: (r) => <span className={styles.mono}>{fmtMoney2(r.amount)}</span>,
      csv: (r) => r.amount,
    },
    {
      key: "fee", header: t("checkCashing.colFee"), align: "right",
      render: (r) => <span className={styles.mono}>{r.status === "cashed" ? fmtMoney2(r.fee) : "—"}</span>,
      csv: (r) => (r.status === "cashed" ? r.fee : ""),
    },
    {
      key: "cash", header: t("checkCashing.colCash"), align: "right",
      render: (r) => <span className={styles.mono}>{r.status === "cashed" ? fmtMoney2(r.cash) : "—"}</span>,
      csv: (r) => (r.status === "cashed" ? r.cash : ""),
    },
    {
      key: "status", header: t("checkCashing.status"),
      render: (r) => (
        <span className={styles.statusCell}>
          <Pill tone={CHECK_STATUS_TONES[r.status] ?? "neutral"}>{checkStatusLabel(r.status)}</Pill>
          {r.bad_check && (
            <Pill tone={BAD_CHECK_STATUS_TONES[r.bad_check.status] ?? "neutral"}>
              {t("checkCashing.badCheckPill")}
            </Pill>
          )}
        </span>
      ),
      csv: (r) => checkStatusLabel(r.status),
    },
    {
      key: "cashier", header: t("checkCashing.colCashier"),
      render: (r) => <span className={styles.muted}>{r.cashier_name || "—"}</span>,
      csv: (r) => r.cashier_name,
    },
    {
      key: "store", header: t("checkCashing.colStore"),
      render: (r) => <span className={styles.muted}>{r.store_name || "—"}</span>,
      csv: (r) => r.store_name,
    },
  ];
}

export default function CheckChecks() {
  const t = useT();
  const navigate = useNavigate();
  const identity = getCurrentIdentity();
  const today = todayIso();
  const filters = useUrlFilterState(
    { q: "", status: "", from: today, to: today }, { pageSizeKey: "check-checks" },
  );
  const { params } = filters;
  const listQuery: CheckListQuery = {
    q: params.q, status: params.status, from: params.from, to: params.to,
  };
  const { data, isLoading, isError, error, refetch } = useChecks({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const report = useCheckReport({ from: params.from, to: params.to });
  const title = navWord("Checks");

  if (identity?.store_id == null) {
    return (
      <DeskPage>
        <PageCrumbs />
        <PageHeader title={title} />
        <Empty>{t("checkCashing.signIn")}</Empty>
      </DeskPage>
    );
  }

  return (
    <DeskPage>
      <PageCrumbs />
      <PageHeader
        title={title}
        subtitle={data ? tn("checkCashing.checkCount", data.total, fmtNumber) : "—"}
      />

      <CheckTotalsGrid totals={report.data?.totals} />

      <Card className={styles.search}>
        <div className={styles.fieldGrid}>
          <Field label={t("checkCashing.search")}>
            <Input
              type="search"
              value={filters.draft.q ?? params.q}
              onChange={(e) => filters.debounced("q", e.target.value)}
              placeholder={t("checkCashing.badSearchPlaceholder")}
            />
          </Field>
          <Field label={t("checkCashing.from")}>
            <DateInput value={params.from} onChange={(e) => filters.setParam("from", e.target.value)} />
          </Field>
          <Field label={t("checkCashing.to")}>
            <DateInput value={params.to} onChange={(e) => filters.setParam("to", e.target.value)} />
          </Field>
        </div>
      </Card>

      <TabsBar>
        {STATUS_TABS.map((s) => (
          <TabsButton
            key={s.slug}
            active={params.status === s.slug}
            onClick={() => filters.setParam("status", s.slug)}
          >
            {t(s.label)}
          </TabsButton>
        ))}
      </TabsBar>

      <DeskPane>
        <Card>
          <DataTable
            columns={columns(t)}
            rows={data?.rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/check-cashing/customers/${r.customer_id}`)}
            rowLabel={(r) => t("checkCashing.openCustomer", { name: r.customer_name })}
            isLoading={isLoading} isError={isError} error={error}
            onRetry={() => { void refetch(); }}
            emptyTitle={t("checkCashing.noChecksInPeriod")}
            page={data && {
              page: data.page, totalPages: data.total_pages, total: data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
            exportCsv={{
              filename: "checks",
              fetchPage: (page, perPage) => fetchChecksPage({ ...listQuery, page, perPage }),
            }}
          />
        </Card>
      </DeskPane>
    </DeskPage>
  );
}
