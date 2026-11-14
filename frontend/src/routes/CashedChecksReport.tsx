import type { ReactNode } from "react";

import { useCheckReport, type CheckTotals } from "../api/checkCashing";
import { CheckTotalsGrid } from "../components/CheckTotals";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  Card, DateInput, Empty, ErrorState, Field, KpiCard, KpiGrid, Loading,
  PageHeader, PageShell, SectionTitle, Select, Table, monoStyle, tdStyle,
  tdStyleRight, thStyle, thStyleRight,
} from "../components/ui";
import { navWord } from "../i18n/navWords";
import { useT } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { formatDate } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "./CheckCashing.module.css";

// Back office → Reports → Check cashing report (/app/reports/check-cashing,
// owners: /app/owner/reports/check-cashing). What the check cashing
// counter did over a period, view only, on any device — a phone
// included (owner, 2026-11-11): no activated computer needed, no ID
// numbers or pictures. Totals, each store, each day, the busiest
// companies and customers, and where bad checks stand.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("Checks and reports").

function TotalsCells({ row }: { row: CheckTotals }) {
  return (
    <>
      <td style={{ ...tdStyleRight, ...monoStyle }}>{fmtNumber(row.cashed)}</td>
      <td style={{ ...tdStyleRight, ...monoStyle }}>{fmtMoney2(row.amount)}</td>
      <td style={{ ...tdStyleRight, ...monoStyle }}>{fmtMoney2(row.fees)}</td>
      <td style={{ ...tdStyleRight, ...monoStyle }}>{fmtMoney2(row.cash)}</td>
    </>
  );
}

function TotalsTable({ first, rows }: {
  first: string;
  rows: Array<{ key: string | number; label: ReactNode; totals: CheckTotals }>;
}) {
  const t = useT();
  return (
    <Table>
      <thead>
        <tr>
          <th style={thStyle}>{first}</th>
          <th style={thStyleRight}>{t("checkCashing.sumCashed")}</th>
          <th style={thStyleRight}>{t("checkCashing.colCheck")}</th>
          <th style={thStyleRight}>{t("checkCashing.colFee")}</th>
          <th style={thStyleRight}>{t("checkCashing.colCash")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td style={tdStyle}>{r.label}</td>
            <TotalsCells row={r.totals} />
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function PartyTable({ title, rows }: {
  title: string;
  rows: Array<{ id: number; name: string; cashed: number; amount: number }>;
}) {
  const t = useT();
  return (
    <Card>
      <SectionTitle>{title}</SectionTitle>
      {rows.length === 0 ? <Empty>{t("checkCashing.noChecksInPeriod")}</Empty> : (
        <Table>
          <thead>
            <tr>
              <th style={thStyle}>{t("checkCashing.name")}</th>
              <th style={thStyleRight}>{t("checkCashing.sumCashed")}</th>
              <th style={thStyleRight}>{t("checkCashing.colCheck")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={tdStyle}>{r.name}</td>
                <td style={{ ...tdStyleRight, ...monoStyle }}>{fmtNumber(r.cashed)}</td>
                <td style={{ ...tdStyleRight, ...monoStyle }}>{fmtMoney2(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export default function CheckCashingReport() {
  const t = useT();
  const filters = useUrlFilterState({ from: "", to: "", store: "" });
  const { params } = filters;
  const report = useCheckReport({ from: params.from, to: params.to, storeId: params.store });
  const title = navWord("Check cashing report");
  const data = report.data;

  let body: ReactNode;
  if (report.isError && !data) {
    body = (
      <ErrorState
        message={apiErrorMessage(report.error, t("checkCashing.loadFailed"))}
        onRetry={() => void report.refetch()}
        busy={report.isFetching}
      />
    );
  } else if (!data) {
    body = <Loading />;
  } else {
    const bad = data.bad_checks;
    body = (
      <div className={styles.reviewStack}>
        <CheckTotalsGrid totals={data.totals} />

        <Card>
          <SectionTitle>{navWord("Bad checks")}</SectionTitle>
          <KpiGrid minWidth="9rem">
            <KpiCard
              label={t("checkCashing.badOpenCount")} value={fmtNumber(bad.open_count)}
              sub={t("checkCashing.repOwedNow", { amount: fmtMoney2(bad.open_owed) })}
              tone={bad.open_owed > 0 ? "warning" : "neutral"}
            />
            <KpiCard
              label={t("checkCashing.repReturned")} value={fmtNumber(bad.returned)}
              sub={fmtMoney2(bad.returned_owed)}
            />
            <KpiCard label={t("checkCashing.repPaidBack")} value={fmtMoney2(bad.paid_back)} />
          </KpiGrid>
        </Card>

        {data.stores.length > 1 && (
          <Card>
            <SectionTitle>{t("checkCashing.repByStore")}</SectionTitle>
            <TotalsTable
              first={t("checkCashing.colStore")}
              rows={data.stores.map((s) => ({ key: s.store_id, label: s.store_name, totals: s }))}
            />
          </Card>
        )}

        <Card>
          <SectionTitle>{t("checkCashing.repByDay")}</SectionTitle>
          {data.days.length === 0 ? <Empty>{t("checkCashing.noChecksInPeriod")}</Empty> : (
            <TotalsTable
              first={t("checkCashing.colDay")}
              rows={data.days.map((d) => ({ key: d.day, label: formatDate(d.day), totals: d }))}
            />
          )}
        </Card>

        <div className={styles.fieldGrid}>
          <PartyTable title={t("checkCashing.repTopCompanies")} rows={data.companies} />
          <PartyTable title={t("checkCashing.repTopCustomers")} rows={data.customers} />
        </div>
      </div>
    );
  }

  return (
    <PageShell>
      <PageCrumbs />
      <PageHeader title={title} subtitle={t("checkCashing.repSubtitle")} />
      <Card className={styles.search}>
        <div className={styles.fieldGrid}>
          <Field label={t("checkCashing.from")}>
            <DateInput
              value={params.from || data?.from_day || ""}
              onChange={(e) => filters.setParam("from", e.target.value)}
            />
          </Field>
          <Field label={t("checkCashing.to")}>
            <DateInput
              value={params.to || data?.to_day || ""}
              onChange={(e) => filters.setParam("to", e.target.value)}
            />
          </Field>
          {data && data.store_options.length > 1 && (
            <Field label={t("checkCashing.colStore")}>
              <Select value={params.store} onChange={(e) => filters.setParam("store", e.target.value)}>
                <option value="">{t("checkCashing.repAllStores")}</option>
                {data.store_options.map((s) => (
                  <option key={s.id} value={String(s.id)}>{s.name}</option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      </Card>
      {body}
    </PageShell>
  );
}
