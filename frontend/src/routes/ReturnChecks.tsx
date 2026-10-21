import { useNavigate } from "react-router-dom";

import {
  RETURN_CHECK_STATUS_TONES, useReturnChecks, type ReturnCheckRow,
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

// Bounced-check workflow list at /app/return-checks. Filter by
// status pill, click any row (or the explicit Edit button) to
// open the edit page where you can update fields, record partial
// payments, or transition the status (Mark loss / Mark fraud /
// Reopen).

const STATUSES: Array<{ slug: string; label: string }> = [
  { slug: "",          label: "All"       },
  { slug: "pending",   label: "Pending"   },
  { slug: "recovered", label: "Recovered" },
  { slug: "loss",      label: "Loss"      },
  { slug: "fraud",     label: "Fraud"     },
];

const COLUMNS: DataColumn<ReturnCheckRow>[] = [
  {
    key: "bounced", header: "Bounced", sortKey: "bounced", sortFirst: "desc",
    render: (r) => <span className={styles.monoMuted}>{formatDate(r.bounced_on)}</span>,
  },
  { key: "customer", header: "Customer", sortKey: "customer", render: (r) => r.customer_name },
  {
    key: "check", header: "Check #", sortKey: "check",
    render: (r) => <span className={styles.mono}>{r.check_number || "—"}</span>,
  },
  { key: "bank", header: "Bank", sortKey: "bank", render: (r) => r.payer_bank || "—" },
  {
    key: "amount", header: "Amount", align: "right", sortKey: "amount", sortFirst: "desc",
    render: (r) => <span className={styles.mono}>{fmtMoney2(r.amount)}</span>,
  },
  {
    key: "recovered", header: "Recovered", align: "right",
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
  { key: "status", header: "Status", sortKey: "status", render: (r) => <StatusPill status={r.status} /> },
  {
    // The explicit, discoverable action; the whole row opens the
    // same page for a cashier who taps any cell.
    key: "edit", header: "", label: "", align: "right",
    render: (r) => (
      <ButtonLink to={`/return-checks/${r.id}/edit`} tone="secondary" size="sm">
        Edit / record payment
      </ButtonLink>
    ),
  },
];

export default function ReturnChecks() {
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
        <PageHeader title="Returned checks" />
        <Empty>Sign in as a store admin to view return checks.</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title="Returned checks"
        subtitle={data
          ? `${fmtNumber(data.total)} ${
              status || "total"
            } check${data.total === 1 ? "" : "s"}`
          : "—"}
        actions={(
          <ButtonLink to="/return-checks/new" tone="primary" size="sm">
            + New return check
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
            {s.label}
          </TabsButton>
        ))}
      </TabsBar>

      <Card>
        <DataTable
          columns={COLUMNS}
          rows={data?.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/return-checks/${r.id}/edit`)}
          rowLabel={(r) => `Open return check from ${r.customer_name}`}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={`No return checks ${status ? `with status ${status}` : "yet"}.`}
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
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <Pill tone={tone}>{label}</Pill>;
}

