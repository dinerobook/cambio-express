import { useNavigate } from "react-router-dom";

import {
  fetchCheckCustomersPage, partyStatusLabel, useCheckCustomers,
  type CheckCustomerRow, type PartyListQuery,
} from "../api/checkCashing";
import { PartyStatusPill } from "../components/CheckCashingFields";
import { DeskPage, DeskPane } from "../components/DeskPage";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  ButtonLink, Card, DataTable, Empty, Field, Input, PageHeader,
  Pill, TabsBar, TabsButton, type DataColumn,
} from "../components/ui";
import { navWord } from "../i18n/navWords";
import { tn, useT, type Translate } from "../i18n";
import { getCurrentIdentity } from "../lib/auth";
import { fmtNumber } from "../lib/formatters";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { STATUS_TABS } from "./checkCashingTabs";
import styles from "./CheckCashing.module.css";

// Check cashing app → Customers (/app/check-cashing/customers).
// Everyone who cashes checks here or at a store sharing this store's
// owner. Live search by name, phone or ID number.

function columns(t: Translate): DataColumn<CheckCustomerRow>[] {
  return [
    {
      key: "name", header: t("checkCashing.name"), sortKey: "name",
      render: (r) => <span className={styles.name}>{r.full_name}</span>,
      csv: (r) => r.full_name,
    },
    {
      key: "phone", header: t("checkCashing.phone"),
      render: (r) => (
        <span className={styles.mono}>
          {r.phone_number ? `${r.phone_country} ${r.phone_number}` : "—"}
        </span>
      ),
      csv: (r) => (r.phone_number ? `${r.phone_country} ${r.phone_number}` : ""),
    },
    {
      key: "id", header: t("checkCashing.idOnFile"),
      render: (r) => (
        <span className={styles.statusCell}>
          <span className={styles.mono}>{r.id_summary || "—"}</span>
          {r.has_expired_id && <Pill tone="warning">{t("checkCashing.idExpired")}</Pill>}
        </span>
      ),
      csv: (r) => r.id_summary,
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

export default function CheckCustomers() {
  const t = useT();
  const navigate = useNavigate();
  const identity = getCurrentIdentity();
  const filters = useUrlFilterState({ q: "", status: "" }, {
    pageSizeKey: "check-customers",
    defaultSort: { key: "name", direction: "asc" },
  });
  const listQuery: PartyListQuery = {
    q: filters.params.q, status: filters.params.status,
    sort: filters.sort?.key, dir: filters.sort?.direction,
  };
  const { data, isLoading, isError, error, refetch } = useCheckCustomers({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const title = navWord("Customers");

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
        subtitle={data ? tn("checkCashing.customerCount", data.total, fmtNumber) : "—"}
        actions={(
          <ButtonLink to="/check-cashing/customers/new" tone="primary" size="sm">
            {t("checkCashing.newCustomer")}
          </ButtonLink>
        )}
      />

      <Card className={styles.search}>
        <Field label={t("checkCashing.search")}>
          <Input
            type="search"
            value={filters.draft.q ?? filters.params.q}
            onChange={(e) => filters.debounced("q", e.target.value)}
            placeholder={t("checkCashing.customerSearchPlaceholder")}
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

      <DeskPane>
        <Card>
        <DataTable
          columns={columns(t)}
          rows={data?.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/check-cashing/customers/${r.id}`)}
          rowLabel={(r) => t("checkCashing.openCustomer", { name: r.full_name })}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={t("checkCashing.noCustomers")}
          sort={filters.sort}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "check-customers",
            fetchPage: (page, perPage) => fetchCheckCustomersPage({ ...listQuery, page, perPage }),
          }}
        />
        </Card>
      </DeskPane>
    </DeskPage>
  );
}
