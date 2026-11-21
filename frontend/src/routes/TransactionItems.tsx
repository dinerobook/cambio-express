import { useState } from "react";

import { useSessionStatus } from "../api/account";
import {
  fetchPosLinesPage, ticketKindLabel, useTransactionLines, type PosLineRow,
} from "../api/posimport";
import { csvMoney } from "../lib/csv";
import {
  AppLink, Card, DataTable, DateInput, Field, Input, KpiCard, KpiGrid,
  PageShell, Pill, Select, tokens, type DataColumn,
} from "../components/ui";
import { ReceiptSplit } from "../components/ReceiptPanel";
import { useOpenReceipt } from "../lib/useOpenReceipt";
import { TransactionsHeader } from "../components/TransactionsHeader";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { csvTimestamp, daysAgoIso, formatTimestamp } from "../lib/datetime";
import styles from "./TransactionItems.module.css";
import { t, useT, type MessageKey } from "../i18n";

// /app/transactions/items — every item the register sold, one row per
// line (Modisoft's item-level transaction report, 2026-11-20): when it
// sold and on which ticket, its scan code and department, the quantity,
// the unit it sold at against its regular price, and the cost and
// margin when the price book holds a cost. A row opens its ticket's
// receipt beside the list, like the Receipts view.
//
// Same money rules as the tickets (server-side): only tickets that
// count are listed, and a voided line is never summed — "Voided items"
// lists them on their own, at the price they rang.

const SHOWS: { value: string; label: MessageKey }[] = [
  { value: "", label: "posItems.showSold" },
  { value: "below_regular", label: "posItems.showBelowRegular" },
  { value: "department_key", label: "posItems.showDepartmentKey" },
  { value: "voided", label: "posItems.showVoided" },
];

const MONO = { fontFamily: tokens.fontMono };

function deptLabel(r: PosLineRow): string {
  if (r.department_name) return r.department_name;
  return r.merchandise_code ? t("posTx.deptNumber", { code: r.merchandise_code }) : "—";
}

// What a line was, beyond its numbers — shown under the item's name
// (a column of its own did not fit beside eleven others) and written
// to the CSV as its own column.
function flagLabels(r: PosLineRow): string[] {
  return [
    r.kind === "refund" ? ticketKindLabel(r.kind) : "",
    r.status === "cancel" ? t("posItems.voided") : "",
    r.below_regular ? t("posItems.belowRegular") : "",
    !r.pos_code && !r.is_fuel ? t("posItems.departmentKey") : "",
  ].filter(Boolean);
}

function qtyLabel(r: PosLineRow): string {
  return r.is_fuel && r.gallons
    ? t("posItems.gallons", { gallons: r.gallons.toFixed(3) })
    : fmtNumber(r.quantity);
}

// Built during render so the headings follow a language switch.
const columns = (): DataColumn<PosLineRow>[] => [
  {
    key: "time", header: t("posTx.colTime"), sortKey: "time", sortFirst: "desc",
    render: (r) => <span className={styles.nowrap}>{r.at ? formatTimestamp(r.at) : r.business_date}</span>,
    csv: (r) => (r.at ? csvTimestamp(r.at) : r.business_date),
  },
  {
    key: "ticket", header: t("posTx.colTicket"),
    render: (r) => (
      <AppLink to={`/transactions/${r.transaction_id}`} className="ds-link" style={MONO}>
        {r.transaction_no || `#${r.transaction_id}`}
      </AppLink>
    ),
    csv: (r) => r.transaction_no,
  },
  {
    key: "code", header: t("posItems.colScanCode"),
    render: (r) => <span style={MONO}>{r.pos_code || "—"}</span>,
    csv: (r) => r.pos_code,
  },
  {
    key: "description", header: t("posItems.colDescription"), sortKey: "description",
    render: (r) => (
      <div className={styles.item}>
        <span className={r.status === "cancel" ? styles.voided : undefined}>{r.description || "—"}</span>
        {(r.kind === "refund" || r.status === "cancel" || r.below_regular) && (
          <span className={styles.flags}>
            {r.kind === "refund" && <Pill tone="neutral">{ticketKindLabel(r.kind)}</Pill>}
            {r.status === "cancel" && <Pill tone="warning">{t("posItems.voided")}</Pill>}
            {r.below_regular && <Pill tone="warning">{t("posItems.belowRegular")}</Pill>}
          </span>
        )}
      </div>
    ),
    csv: (r) => r.description,
  },
  { key: "department", header: t("posItems.colDepartment"), render: deptLabel, csv: deptLabel },
  {
    key: "qty", header: t("posTx.colQty"), align: "right", sortKey: "qty", sortFirst: "desc",
    render: (r) => <span style={MONO}>{qtyLabel(r)}</span>,
    csv: (r) => r.quantity,
  },
  {
    key: "unit", header: t("posItems.colSoldAt"), align: "right",
    render: (r) => (
      <span style={MONO} className={r.below_regular ? styles.below : undefined}>
        {fmtMoney2(r.unit_price)}
      </span>
    ),
    csv: (r) => csvMoney(r.unit_price),
  },
  {
    key: "regular", header: t("posItems.colRegular"), align: "right",
    render: (r) => <span style={MONO}>{r.regular_price ? fmtMoney2(r.regular_price) : "—"}</span>,
    csv: (r) => (r.regular_price ? csvMoney(r.regular_price) : ""),
  },
  {
    key: "amount", header: t("posTx.colAmount"), align: "right", sortKey: "amount", sortFirst: "desc",
    render: (r) => <span style={MONO}>{fmtMoney2(r.amount)}</span>,
    csv: (r) => csvMoney(r.amount),
  },
  {
    key: "cost", header: t("posItems.colCost"), align: "right",
    render: (r) => <span style={MONO}>{r.cost != null ? fmtMoney2(r.cost) : "—"}</span>,
    csv: (r) => (r.cost != null ? csvMoney(r.cost) : ""),
  },
  {
    key: "margin", header: t("posItems.colMargin"), align: "right",
    render: (r) => (
      <span style={MONO}>{r.margin_pct != null ? t("posItems.pct", { pct: r.margin_pct.toFixed(1) }) : "—"}</span>
    ),
    csv: (r) => (r.margin_pct != null ? r.margin_pct : ""),
  },
];

export default function TransactionItems() {
  useT(); // re-render on a language switch
  const storeName = useSessionStatus().data?.store_name;
  const receipt = useOpenReceipt();
  const [defaults] = useState(() => ({ start: daysAgoIso(6), end: daysAgoIso(0) }));
  const filters = useUrlFilterState({
    q: "", department: "", show: "", start: defaults.start, end: defaults.end,
  }, { pageSizeKey: "pos-items", defaultSort: { key: "time", direction: "desc" } });
  const listQuery = {
    start: filters.params.start,
    end: filters.params.end,
    q: filters.params.q,
    department: filters.params.department,
    show: filters.params.show,
    sort: filters.sort?.key,
    dir: filters.sort?.direction,
  };
  const list = useTransactionLines({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const data = list.data;
  const margin = data && data.costed_amount > 0
    ? ((data.costed_amount - data.total_cost) / data.costed_amount) * 100
    : null;

  return (
    <PageShell maxWidth="92rem">
      <TransactionsHeader
        start={filters.params.start} end={filters.params.end}
        current={t("posTx.viewItems")}
      />

      {/* The kit filter bar: search first, then the filters, on one row. */}
      <div className="ds-filter-bar">
        <Field label={t("posTx.search")}>
          <Input
            type="search"
            placeholder={t("posItems.searchPlaceholder")}
            value={filters.draft.q ?? filters.params.q}
            onChange={(e) => filters.debounced("q", e.target.value)}
          />
        </Field>
        <Field label={t("posTx.from")}>
          <DateInput
            value={filters.params.start}
            onChange={(e) => filters.setParam("start", e.target.value)}
          />
        </Field>
        <Field label={t("posTx.to")}>
          <DateInput
            value={filters.params.end}
            onChange={(e) => filters.setParam("end", e.target.value)}
          />
        </Field>
        <Field label={t("posItems.colDepartment")}>
          <Select
            value={filters.params.department}
            onChange={(e) => filters.setParam("department", e.target.value)}
          >
            <option value="">{t("posItems.allDepartments")}</option>
            {data?.departments.map((d) => (
              <option key={d.code} value={d.code}>{d.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("posItems.show")}>
          <Select
            value={filters.params.show}
            onChange={(e) => filters.setParam("show", e.target.value)}
          >
            {SHOWS.map((s) => <option key={s.value} value={s.value}>{t(s.label)}</option>)}
          </Select>
        </Field>
      </div>

      {data && (
        <KpiGrid>
          <KpiCard
            label={t("posItems.lines")}
            value={fmtNumber(data.total)}
            sub={`${filters.params.start} → ${filters.params.end}`}
          />
          <KpiCard
            label={t("posItems.quantity")}
            value={fmtNumber(data.total_quantity)}
            sub={data.total_gallons > 0
              ? t("posItems.plusGallons", { gallons: fmtNumber(Math.round(data.total_gallons)) })
              : undefined}
          />
          <KpiCard
            label={filters.params.show === "voided" ? t("posItems.voidedAmount") : t("posItems.sold")}
            value={fmtMoney2(data.total_amount)}
            tone={filters.params.show === "voided" ? "neutral" : "positive"}
          />
          <KpiCard
            label={t("posItems.margin")}
            value={margin != null ? t("posItems.pct", { pct: margin.toFixed(1) }) : "—"}
            sub={margin != null
              ? t("posItems.marginOn", { amount: fmtMoney2(data.costed_amount) })
              : t("posItems.noCost")}
          />
        </KpiGrid>
      )}

      <Card>
        <ReceiptSplit selected={receipt.selected} storeName={storeName} onClose={receipt.close}>
          <DataTable
            columns={columns()}
            rows={data?.rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => receipt.open(r.transaction_id)}
            rowLabel={(r) => t("posTx.openTicket", { ticket: r.transaction_no || r.transaction_id })}
            rowClassName={(r) => receipt.rowClass(r.transaction_id)}
            sort={filters.sort}
            isLoading={list.isLoading} isError={list.isError} error={list.error}
            onRetry={() => { void list.refetch(); }}
            errorMessage={t("posItems.loadFailed")}
            emptyTitle={t("posItems.empty")}
            emptyBody={t("posTx.emptyBody")}
            page={data && {
              page: data.page, totalPages: data.total_pages, total: data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
            exportCsv={{
              filename: `pos-items-${listQuery.start}-to-${listQuery.end}`,
              fetchPage: (page, perPage) => fetchPosLinesPage({ ...listQuery, page, perPage }),
              extraColumns: [{ header: t("posTx.colFlags"), csv: (r) => flagLabels(r).join("; ") }],
            }}
          />
        </ReceiptSplit>
      </Card>
    </PageShell>
  );
}
