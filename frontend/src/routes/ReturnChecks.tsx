import { useNavigate } from "react-router-dom";

import {
  RETURN_CHECK_STATUS_TONES, returnCheckStatusLabel, useReturnChecks,
  type ReturnCheckRow,
} from "../api/returnChecks";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  ButtonLink, Card, DataTable, Empty, PageHeader,
  PageShell, Pill, TabsBar, TabsButton, type DataColumn,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "./ReturnChecks.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { tn, useT, type MessageKey, type Translate } from "../i18n";

// Bounced-check workflow list at /app/return-checks. Filter by
// status pill, click any row (or the explicit Edit button) to
// open the edit page where you can update fields, record partial
// payments, or transition the status (Mark loss / Mark fraud /
// Reopen).

const STATUSES: Array<{ slug: string; label: MessageKey }> = [
  { slug: "",          label: "returnCheck.all"             },
  { slug: "pending",   label: "returnCheck.statusPending"   },
  { slug: "recovered", label: "returnCheck.statusRecovered" },
  { slug: "loss",      label: "returnCheck.statusLoss"      },
  { slug: "fraud",     label: "returnCheck.statusFraud"     },
];

// Built during render so the headings follow the language.
function returnCheckColumns(t: Translate): DataColumn<ReturnCheckRow>[] {
  return [
  {
    key: "bounced", header: t("returnCheck.bounced"), sortKey: "bounced", sortFirst: "desc",
    render: (r) => <span className={styles.monoMuted}>{formatDate(r.bounced_on)}</span>,
  },
  { key: "customer", header: t("transfer.customer"), sortKey: "customer", render: (r) => r.customer_name },
  {
    key: "check", header: t("returnCheck.checkNumberShort"), sortKey: "check",
    render: (r) => <span className={styles.mono}>{r.check_number || "—"}</span>,
  },
  { key: "bank", header: t("returnCheck.bank"), sortKey: "bank", render: (r) => r.payer_bank || "—" },
  {
    key: "amount", header: t("dash.amount"), align: "right", sortKey: "amount", sortFirst: "desc",
    render: (r) => <span className={styles.mono}>{fmtMoney2(r.amount)}</span>,
  },
  {
    key: "recovered", header: t("returnCheck.statusRecovered"), align: "right",
    render: (r) => (
      <span>
        <span className={r.recovered_total >= r.amount + r.return_check_fee ? styles.recoveredFull : styles.mono}>
          {fmtMoney2(r.recovered_total)}
        </span>
        {r.payment_count > 0 && (
          <span className={styles.paymentCount}>({r.payment_count})</span>
        )}
      </span>
    ),
  },
  { key: "status", header: t("transfer.status"), sortKey: "status", render: (r) => <StatusPill status={r.status} /> },
  {
    // The explicit, discoverable action; the whole row opens the
    // same page for a cashier who taps any cell.
    key: "edit", header: "", label: "", align: "right",
    render: (r) => (
      <ButtonLink to={`/return-checks/${r.id}/edit`} tone="secondary" size="sm">
        {t("returnCheck.editOrPay")}
      </ButtonLink>
    ),
  },
  ];
}

export default function ReturnChecks() {
  const t = useT();
  const columns = returnCheckColumns(t);
  const identity = getCurrentIdentity();
  const navigate = useNavigate();
  const filters = useUrlFilterState({ status: "" }, {
    pageSizeKey: "return-checks",
    defaultSort: { key: "bounced", direction: "desc" },
  });
  const status = filters.params.status;
  const { data, isLoading, isError, error, refetch } = useReturnChecks({
    status,
    sort: filters.sort?.key,
    dir: filters.sort?.direction,
    page: filters.page,
    perPage: filters.perPage,
  });

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title={t("returnCheck.listTitle")} />
        <Empty>{t("returnCheck.listSignIn")}</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={t("returnCheck.listTitle")}
        subtitle={data
          ? status
            ? tn("returnCheck.countWithStatus", data.total, fmtNumber, {
                status: returnCheckStatusLabel(status).toLowerCase(),
              })
            : tn("returnCheck.countTotal", data.total, fmtNumber)
          : "—"}
        actions={(
          <ButtonLink to="/return-checks/new" tone="primary" size="sm">
            {t("returnCheck.newButton")}
          </ButtonLink>
        )}
      />

      <TabsBar>
        {STATUSES.map((s) => (
          <TabsButton
            key={s.slug}
            active={status === s.slug}
            onClick={() => filters.setParam("status", s.slug)}
          >
            {t(s.label)}
          </TabsButton>
        ))}
      </TabsBar>

      <Card>
        <DataTable
          columns={columns}
          rows={data?.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/return-checks/${r.id}/edit`)}
          rowLabel={(r) => t("returnCheck.openFrom", { name: r.customer_name })}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={status
            ? t("returnCheck.emptyWithStatus", { status: returnCheckStatusLabel(status).toLowerCase() })
            : t("returnCheck.empty")}
          sort={filters.sort}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
        />
      </Card>
    </PageShell>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = RETURN_CHECK_STATUS_TONES[status] ?? "neutral";
  return <Pill tone={tone}>{returnCheckStatusLabel(status)}</Pill>;
}

