import { useNavigate } from "react-router-dom";

import {
  fetchCheckCompaniesPage, partyStatusLabel, useCheckCompanies,
  type CheckCompanyRow, type PartyListQuery,
} from "../api/checkCashing";
import { PartyStatusPill } from "../components/CheckCashingFields";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  ButtonLink, Card, DataTable, Empty, Field, Input, PageHeader, PageShell,
  TabsBar, TabsButton, type DataColumn,
} from "../components/ui";
import { navWord } from "../i18n/navWords";
import { tn, useT, type Translate } from "../i18n";
import { getCurrentIdentity } from "../lib/auth";
import { fmtNumber } from "../lib/formatters";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { STATUS_TABS } from "./checkCashingTabs";
import styles from "./CheckCashing.module.css";

// Check cashing app → Companies (/app/check-cashing/companies).
// Whoever writes the checks (employers, agencies), found by the
// routing and account numbers printed on the check.

function columns(t: Translate): DataColumn<CheckCompanyRow>[] {
  return [
    {
      key: "name", header: t("checkCashing.companyName"), sortKey: "name",
      render: (r) => <span className={styles.name}>{r.name}</span>,
      csv: (r) => r.name,
    },
    {
      key: "routing", header: t("checkCashing.routing"),
      render: (r) => <span className={styles.mono}>{r.routing_number || "—"}</span>,
      csv: (r) => r.routing_number,
    },
    {
      key: "account", header: t("checkCashing.account"),
      render: (r) => (
        <span className={styles.mono}>{r.account_last4 ? `••••${r.account_last4}` : "—"}</span>
      ),
      csv: (r) => (r.account_last4 ? `••••${r.account_last4}` : ""),
    },
    {
      key: "status", header: t("checkCashing.status"), sortKey: "status",
      render: (r) => <PartyStatusPill status={r.status} />,
      csv: (r) => partyStatusLabel(r.status),
    },
    {
      key: "store", header: t("checkCashing.homeStore"),
      render: (r) => <span className={styles.muted}>{r.home_store_name || "—"}</span>,
      csv: (r) => r.home_store_name,
    },
  ];
}

export default function CheckCompanies() {
  const t = useT();
  const navigate = useNavigate();
  const identity = getCurrentIdentity();
  const filters = useUrlFilterState({ q: "", status: "" }, {
    pageSizeKey: "check-companies",
    defaultSort: { key: "name", direction: "asc" },
  });
  const listQuery: PartyListQuery = {
    q: filters.params.q, status: filters.params.status,
    sort: filters.sort?.key, dir: filters.sort?.direction,
  };
  const { data, isLoading, isError, error, refetch } = useCheckCompanies({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const title = navWord("Companies");

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title={title} />
        <Empty>{t("checkCashing.signIn")}</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageCrumbs />
      <PageHeader
        title={title}
        subtitle={data ? tn("checkCashing.companyCount", data.total, fmtNumber) : "—"}
        actions={(
          <ButtonLink to="/check-cashing/companies/new" tone="primary" size="sm">
            {t("checkCashing.newCompany")}
          </ButtonLink>
        )}
      />

      <Card className={styles.search}>
        <Field label={t("checkCashing.search")}>
          <Input
            type="search"
            value={filters.draft.q ?? filters.params.q}
            onChange={(e) => filters.debounced("q", e.target.value)}
            placeholder={t("checkCashing.companySearchPlaceholder")}
          />
        </Field>
      </Card>

      <TabsBar>
        {STATUS_TABS.map((s) => (
          <TabsButton
            key={s.slug}
            active={filters.params.status === s.slug}
            onClick={() => filters.setParam("status", s.slug)}
          >
            {t(s.label)}
          </TabsButton>
        ))}
      </TabsBar>

      <Card>
        <DataTable
          columns={columns(t)}
          rows={data?.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/check-cashing/companies/${r.id}`)}
          rowLabel={(r) => t("checkCashing.openCompany", { name: r.name })}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={t("checkCashing.noCompanies")}
          sort={filters.sort}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "check-companies",
            fetchPage: (page, perPage) => fetchCheckCompaniesPage({ ...listQuery, page, perPage }),
          }}
        />
      </Card>
    </PageShell>
  );
}
