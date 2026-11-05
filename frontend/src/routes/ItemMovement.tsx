import { useState } from "react";

import {
  fetchItemMovementPage, useItemMovement, type ItemMovement as ItemMovementData,
} from "../api/posimport";
import { csvMoney } from "../lib/csv";
import {
  Card, DataTable, DateInput, Field, InfoTip, Input,
  KpiCard, KpiGrid, PageHeader, PageShell, Pill,
  Section, tokens, type DataColumn,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { daysAgoIso } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";

// /app/store-reports/item-movement (G-2) — per-item quantity +
// dollars over a date range from the booked Gilbarco journal
// data. Top sellers first. Populates as business days book
// (automatically once the site agent + mapping are in place).

type MovementRow = ItemMovementData["rows"][number];

const MONO = { fontFamily: tokens.fontMono };

const COLUMNS: DataColumn<MovementRow>[] = [
  { key: "code", header: "Scan code", render: (r) => <span style={MONO}>{r.pos_code}</span>,
    csv: (r) => r.pos_code },
  { key: "item", header: "Item", render: (r) => r.description || "—", csv: (r) => r.description },
  { key: "qty", header: "Qty", align: "right", render: (r) => <span style={MONO}>{r.quantity.toLocaleString()}</span>,
    csv: (r) => r.quantity },
  { key: "dollars", header: "Dollars", align: "right", render: (r) => <span style={MONO}>{fmtMoney2(r.amount)}</span>,
    csv: (r) => csvMoney(r.amount) },
  { key: "avg", header: "Avg price", align: "right", render: (r) => <span style={MONO}>{fmtMoney2(r.avg_price)}</span>,
    csv: (r) => csvMoney(r.avg_price) },
  {
    key: "flags", header: "", label: "", csvHeader: "In price book",
    render: (r) => (!r.in_price_book ? <Pill tone="warning">not in price book</Pill> : null),
    csv: (r) => (r.in_price_book ? "Yes" : "No"),
  },
];

export default function ItemMovement() {
  const [defaults] = useState(() => ({
    start: daysAgoIso(6), end: daysAgoIso(0),
  }));
  const filters = useUrlFilterState({
    q: "", start: defaults.start, end: defaults.end,
  }, { pageSizeKey: "item-movement" });
  const listQuery = {
    start: filters.params.start,
    end: filters.params.end,
    q: filters.params.q,
  };
  const movement = useItemMovement({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const data = movement.data;

  return (
    <PageShell maxWidth="72rem">
      <PageCrumbs current="Item movement" />
      <PageHeader
        title={
          <>
            Item movement
            <InfoTip text="What actually sold, item by item, from your register's journal data. Rows appear as business days are booked — automatic once the site agent is pushing and your merchandise codes are mapped." />
          </>
        }
        subtitle="Per-item quantity and dollars — top sellers first."
      />

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <Field label="From">
          <DateInput
            value={filters.params.start}
            onChange={(e) => filters.setParam("start", e.target.value)}
          />
        </Field>
        <Field label="To">
          <DateInput
            value={filters.params.end}
            onChange={(e) => filters.setParam("end", e.target.value)}
          />
        </Field>
        <div style={{ flex: 1, minWidth: "14rem" }}>
          <Field label="Search">
            <Input
              type="search"
              placeholder="Description or scan code…"
              value={filters.draft.q ?? filters.params.q}
              onChange={(e) => filters.debounced("q", e.target.value)}
            />
          </Field>
        </div>
      </div>

      {data && (
        <KpiGrid>
          <KpiCard
            label="Items sold"
            value={fmtNumber(data.total)}
            sub={`${data.start} → ${data.end}`}
          />
          <KpiCard
            label="Units"
            value={data.total_quantity.toLocaleString()}
          />
          <KpiCard
            label="Dollars"
            value={fmtMoney2(data.total_amount)}
            tone="positive"
          />
        </KpiGrid>
      )}

      <Section title="Items">
        <Card>
          <DataTable
            columns={COLUMNS}
            rows={data?.rows}
            rowKey={(r) => r.pos_code}
            isLoading={movement.isLoading} isError={movement.isError} error={movement.error}
            onRetry={() => { void movement.refetch(); }}
            errorMessage="Could not load item movement."
            emptyTitle="No movement in this range"
            emptyBody="Data appears here as business days are booked from your register journals. Check the range, or set up the site agent under POS import."
            page={data && {
              page: data.page, totalPages: data.total_pages, total: data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
            exportCsv={{
              filename: `item-movement-${listQuery.start}-to-${listQuery.end}`,
              fetchPage: (page, perPage) => fetchItemMovementPage({ ...listQuery, page, perPage }),
            }}
          />
        </Card>
      </Section>
    </PageShell>
  );
}
