import { useNavigate } from "react-router-dom";

import {
  fetchReturnChecksPage, returnCheckStatusLabel, useReturnChecks,
  type ReturnCheckRow,
} from "../api/returnChecks";
import { csvMoney } from "../lib/csv";
import { getCurrentIdentity } from "../lib/auth";
import { csvDate, formatDate } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  Button, ButtonLink, Card, DataTable, Empty, Field, Input, PageHeader,
  PageShell, Pill, Select, type CsvColumn, type DataColumn,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "./ReturnChecks.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { ReturnChecksHeader } from "../components/ReturnChecksHeader";
import { ReturnCheckStatusPill } from "../components/ReturnCheckStatusPill";
import { tn, useT, type MessageKey, type Translate } from "../i18n";

// The Checks view of /app/return-checks: every returned check,
// searched as you type, filtered by status — and, when opened from
// the By company / By customer lists, by that company or customer.
// Click a row (or the explicit Edit button) to open the edit page
// where you can update fields, record partial payments, or move the
// status (Mark loss / Mark fraud / Reopen).

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
    csv: (r) => csvDate(r.bounced_on),
  },
  { key: "customer", header: t("transfer.customer"), sortKey: "customer", render: (r) => r.customer_name,
    csv: (r) => r.customer_name },
  { key: "company", header: t("returnCheck.company"), sortKey: "company",
    render: (r) => r.company_name || "—", csv: (r) => r.company_name },
  {
    key: "check", header: t("returnCheck.checkNumberShort"), sortKey: "check",
    render: (r) => <span className={styles.mono}>{r.check_number || "—"}</span>,
    csv: (r) => r.check_number,
  },
  { key: "bank", header: t("returnCheck.bank"), sortKey: "bank", render: (r) => r.payer_bank || "—",
    csv: (r) => r.payer_bank },
  {
    key: "amount", header: t("dash.amount"), align: "right", sortKey: "amount", sortFirst: "desc",
    render: (r) => <span className={styles.mono}>{fmtMoney2(r.amount)}</span>,
    csv: (r) => csvMoney(r.amount),
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
    csv: (r) => csvMoney(r.recovered_total),
  },
  { key: "status", header: t("transfer.status"), sortKey: "status", render: (r) => <ReturnCheckStatusPill status={r.status} />,
    csv: (r) => returnCheckStatusLabel(r.status) },
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

function csvExtras(t: Translate): CsvColumn<ReturnCheckRow>[] {
  return [
    { header: t("returnCheck.csvFee"), csv: (r) => csvMoney(r.return_check_fee) },
    { header: t("returnCheck.csvPayments"), csv: (r) => r.payment_count },
    { header: t("returnCheck.csvBatch"), csv: (r) => r.batch_reference || (r.batch_id ? `#${r.batch_id}` : "") },
    { header: t("returnCheck.routingNumber"), csv: (r) => r.routing_number },
    { header: t("returnCheck.accountNumber"), csv: (r) => r.account_number },
  ];
}

export default function ReturnChecks() {
  const t = useT();
  const columns = returnCheckColumns(t);
  const identity = getCurrentIdentity();
  const navigate = useNavigate();
  const filters = useUrlFilterState(
    { status: "", q: "", company: "", customer: "" },
    {
      pageSizeKey: "return-checks",
      defaultSort: { key: "bounced", direction: "desc" },
    },
  );
  const { status, q, company, customer } = filters.params;
  const listQuery = {
    status, q, company, customer,
    sort: filters.sort?.key, dir: filters.sort?.direction,
  };
  const { data, isLoading, isError, error, refetch } = useReturnChecks({
    ...listQuery, page: filters.page, perPage: filters.perPage,
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

  // Opened from By company / By customer: name the party with the
  // spelling on its checks (the URL carries the grouping key).
  const first = data?.rows[0];
  const party = company
    ? { label: t("returnCheck.forCompany", { name: first?.company_name || company }), key: "company" as const }
    : customer
      ? { label: t("returnCheck.forCustomer", { name: first?.customer_name || customer }), key: "customer" as const }
      : null;

  return (
    <PageShell>
      <ReturnChecksHeader
        subtitle={data
          ? status
            ? tn("returnCheck.countWithStatus", data.total, fmtNumber, {
                status: returnCheckStatusLabel(status).toLowerCase(),
              })
            : tn("returnCheck.countTotal", data.total, fmtNumber)
          : "—"}
      />

      <Card className="ds-filter-bar">
        <Field label={t("transfer.search")}>
          <Input
            type="search"
            value={filters.draft.q ?? q}
            onChange={(e) => filters.debounced("q", e.target.value)}
            placeholder={t("returnCheck.searchPlaceholder")}
          />
        </Field>
        <Field label={t("transfer.status")}>
          <Select value={status} onChange={(e) => filters.setParam("status", e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s.slug} value={s.slug}>{t(s.label)}</option>
            ))}
          </Select>
        </Field>
      </Card>

      {party && (
        <div className={styles.partyFilter}>
          <Pill tone="info">{party.label}</Pill>
          <Button tone="secondary" size="sm" onClick={() => filters.setParam(party.key, "")}>
            {t("returnCheck.showAll")}
          </Button>
        </div>
      )}

      <Card>
        <DataTable
          columns={columns}
          rows={data?.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/return-checks/${r.id}/edit`)}
          rowLabel={(r) => t("returnCheck.openFrom", { name: r.customer_name })}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={q || party
            ? t("returnCheck.noMatches")
            : status
              ? t("returnCheck.emptyWithStatus", { status: returnCheckStatusLabel(status).toLowerCase() })
              : t("returnCheck.empty")}
          sort={filters.sort}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "returned-checks",
            fetchPage: (page, perPage) => fetchReturnChecksPage({ ...listQuery, page, perPage }),
            extraColumns: csvExtras(t),
          }}
        />
      </Card>
    </PageShell>
  );
}
