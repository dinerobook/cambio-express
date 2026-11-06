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
import { t, useT } from "../i18n";

// /app/store-reports/item-movement (G-2) — per-item quantity +
// dollars over a date range from the booked Gilbarco journal
// data. Top sellers first. Populates as business days book
// (automatically once the site agent + mapping are in place).

type MovementRow = ItemMovementData["rows"][number];

const MONO = { fontFamily: tokens.fontMono };

// Built during render so the headings follow a language switch.
const columns = (): DataColumn<MovementRow>[] => [
  { key: "code", header: t("posTx.colScanCode"), render: (r) => <span style={MONO}>{r.pos_code}</span>,
    csv: (r) => r.pos_code },
  { key: "item", header: t("posTx.colItem"), render: (r) => r.description || "—", csv: (r) => r.description },
  { key: "qty", header: t("posTx.colQty"), align: "right", render: (r) => <span style={MONO}>{r.quantity.toLocaleString()}</span>,
    csv: (r) => r.quantity },
  { key: "dollars", header: t("move.colDollars"), align: "right", render: (r) => <span style={MONO}>{fmtMoney2(r.amount)}</span>,
    csv: (r) => csvMoney(r.amount) },
  { key: "avg", header: t("move.colAvg"), align: "right", render: (r) => <span style={MONO}>{fmtMoney2(r.avg_price)}</span>,
    csv: (r) => csvMoney(r.avg_price) },
  {
    key: "flags", header: "", label: "", csvHeader: t("move.inPriceBook"),
    render: (r) => (!r.in_price_book ? <Pill tone="warning">{t("move.notInPriceBook")}</Pill> : null),
    csv: (r) => (r.in_price_book ? t("move.yes") : t("move.no")),
  },
];

export default function ItemMovement() {
  useT(); // re-render on a language switch
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
      <PageCrumbs current={t("move.title")} />
      <PageHeader
        title={
          <>
            {t("move.title")}
            <InfoTip text={t("move.tip")} />
          </>
        }
        subtitle={t("move.subtitle")}
      />

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
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
        <div style={{ flex: 1, minWidth: "14rem" }}>
          <Field label={t("posTx.search")}>
            <Input
              type="search"
              placeholder={t("move.searchPlaceholder")}
              value={filters.draft.q ?? filters.params.q}
              onChange={(e) => filters.debounced("q", e.target.value)}
            />
          </Field>
        </div>
      </div>

      {data && (
        <KpiGrid>
          <KpiCard
            label={t("move.itemsSold")}
            value={fmtNumber(data.total)}
            sub={`${data.start} → ${data.end}`}
          />
          <KpiCard
            label={t("move.units")}
            value={data.total_quantity.toLocaleString()}
          />
          <KpiCard
            label={t("move.colDollars")}
            value={fmtMoney2(data.total_amount)}
            tone="positive"
          />
        </KpiGrid>
      )}

      <Section title={t("posTx.items")}>
        <Card>
          <DataTable
            columns={columns()}
            rows={data?.rows}
            rowKey={(r) => r.pos_code}
            isLoading={movement.isLoading} isError={movement.isError} error={movement.error}
            onRetry={() => { void movement.refetch(); }}
            errorMessage={t("move.loadFailed")}
            emptyTitle={t("move.empty")}
            emptyBody={t("move.emptyBody")}
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
