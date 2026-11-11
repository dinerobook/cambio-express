import { useState } from "react";

import {
  BAD_CHECK_STATUS_TONES, badCheckReasonLabel, badCheckStatusLabel,
  fetchBadChecksPage, useBadChecks, type BadCheckListQuery, type BadCheckRow,
} from "../api/checkCashing";
import { BadCheckModal } from "../components/BadCheck";
import { DeskPage, DeskPane } from "../components/DeskPage";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  Card, DataTable, Empty, Field, Input, KpiCard, KpiGrid, PageHeader, Pill,
  TabsBar, TabsButton, type DataColumn,
} from "../components/ui";
import { navWord } from "../i18n/navWords";
import { tn, useT, type MessageKey, type Translate } from "../i18n";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "./CheckCashing.module.css";

// Check cashing app → Bad checks (/app/check-cashing/bad-checks).
// Checks the bank sent back, at every store of the owner (a customer
// may pay back at any of them): open first, with what is still owed.
// A row opens the bad check: payments, record one, write off.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("Bad checks").

/** The tabs: "" (the default) is Open. */
const VIEWS: Array<{ slug: string; status: string; label: MessageKey }> = [
  { slug: "",            status: "open",        label: "checkCashing.badViewOpen" },
  { slug: "paid",        status: "paid",        label: "checkCashing.badViewPaid" },
  { slug: "written_off", status: "written_off", label: "checkCashing.badViewWrittenOff" },
  { slug: "all",         status: "",            label: "checkCashing.all" },
];

function columns(t: Translate): DataColumn<BadCheckRow>[] {
  return [
    {
      key: "returned", header: t("checkCashing.colReturned"),
      render: (r) => <span className={styles.mono}>{formatDate(r.returned_on)}</span>,
      csv: (r) => r.returned_on,
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
      key: "check", header: t("checkCashing.colCheck"), align: "right",
      render: (r) => <span className={styles.mono}>{fmtMoney2(r.amount)}</span>,
      csv: (r) => r.amount,
    },
    {
      key: "reason", header: t("checkCashing.colReason"),
      render: (r) => badCheckReasonLabel(r.reason),
      csv: (r) => badCheckReasonLabel(r.reason),
    },
    {
      key: "balance", header: t("checkCashing.colBalance"), align: "right",
      render: (r) => <span className={styles.mono}>{fmtMoney2(r.balance)}</span>,
      csv: (r) => r.balance,
    },
    {
      key: "status", header: t("checkCashing.status"),
      render: (r) => (
        <Pill tone={BAD_CHECK_STATUS_TONES[r.status] ?? "neutral"}>
          {badCheckStatusLabel(r.status)}
        </Pill>
      ),
      csv: (r) => badCheckStatusLabel(r.status),
    },
    {
      key: "store", header: t("checkCashing.colStore"),
      render: (r) => <span className={styles.muted}>{r.store_name || "—"}</span>,
      csv: (r) => r.store_name,
    },
  ];
}

export default function BadChecks() {
  const t = useT();
  const identity = getCurrentIdentity();
  const filters = useUrlFilterState({ q: "", view: "" }, { pageSizeKey: "bad-checks" });
  const view = VIEWS.find((v) => v.slug === filters.params.view) ?? VIEWS[0];
  const listQuery: BadCheckListQuery = { q: filters.params.q, status: view.status };
  const { data, isLoading, isError, error, refetch } = useBadChecks({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const [open, setOpen] = useState<number | null>(null);
  const title = navWord("Bad checks");

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
        subtitle={data ? tn("checkCashing.badCheckCount", data.total, fmtNumber) : "—"}
      />

      <KpiGrid minWidth="10rem">
        <KpiCard
          label={t("checkCashing.badOpenCount")}
          value={data ? fmtNumber(data.open_count) : "—"}
        />
        <KpiCard
          label={t("checkCashing.badOpenOwed")}
          value={data ? fmtMoney2(data.open_owed) : "—"}
          tone={data && data.open_owed > 0 ? "warning" : "neutral"}
        />
      </KpiGrid>

      <Card className={styles.search}>
        <Field label={t("checkCashing.search")}>
          <Input
            type="search"
            value={filters.draft.q ?? filters.params.q}
            onChange={(e) => filters.debounced("q", e.target.value)}
            placeholder={t("checkCashing.badSearchPlaceholder")}
          />
        </Field>
      </Card>

      <TabsBar>
        {VIEWS.map((v) => (
          <TabsButton
            key={v.slug}
            active={view.slug === v.slug}
            onClick={() => filters.setParam("view", v.slug)}
          >
            {t(v.label)}
          </TabsButton>
        ))}
      </TabsBar>

      <DeskPane>
        <Card>
          <DataTable
            columns={columns(t)}
            rows={data?.rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpen(r.id)}
            rowLabel={(r) => t("checkCashing.openBadCheck", { name: r.customer_name })}
            isLoading={isLoading} isError={isError} error={error}
            onRetry={() => { void refetch(); }}
            emptyTitle={t("checkCashing.noBadChecks")}
            emptyBody={t("checkCashing.noBadChecksHint")}
            page={data && {
              page: data.page, totalPages: data.total_pages, total: data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
            exportCsv={{
              filename: "bad-checks",
              fetchPage: (page, perPage) => fetchBadChecksPage({ ...listQuery, page, perPage }),
            }}
          />
        </Card>
      </DeskPane>

      <BadCheckModal id={open} onClose={() => setOpen(null)} />
    </DeskPage>
  );
}
