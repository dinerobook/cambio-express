import { useState } from "react";
import {
  CategoryScale, Chart as ChartJS, Filler, LinearScale, LineElement,
  PointElement, Tooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";

import { useOwnerDashboard } from "../api/owner";
import { AppLink,
  Breadcrumbs,
  Card, ErrorState, KpiCard, KpiGrid, Loading, PageHeader, PageShell,
  Section, TabsBar, TabsButton, Table, tdStyle, thStyle,
  Empty,
  thStyleRight,
  tdStyleRight,
} from "../components/ui";
import { apiErrorMessage } from "../lib/api";
import { chartSeries, moneyChartOptions, seriesFill } from "../lib/chartOptions";
import { fmtMoney, fmtMoney2, fmtNumber } from "../lib/formatters";
import { Delta } from "../components/Delta";
import styles from "./OwnerDashboard.module.css";

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip,
);

type Period = "today" | "month" | "year";

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "today", label: "Today" },
  { value: "month", label: "This Month" },
  { value: "year",  label: "This Year" },
];


export default function OwnerDashboard() {
  const [period, setPeriod] = useState<Period>("month");
  const { data, isLoading, isError, error, refetch } = useOwnerDashboard(period);

  return (
    <PageShell gap="1.25rem">

      <Breadcrumbs crumbs={[{ label: "Owner dashboard" }]} />

      <PageHeader
        title="Owner Dashboard"
        actions={(
          <TabsBar>
            {PERIODS.map((p) => (
              <TabsButton
                key={p.value}
                active={p.value === period}
                onClick={() => setPeriod(p.value)}
              >
                {p.label}
              </TabsButton>
            ))}
          </TabsBar>
        )}
      />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={`Couldn't load dashboard — ${apiErrorMessage(error, "unknown")}`}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <>
          <KpiGrid>
            <KpiCard
              label="Total Transfers"
              value={data.agg_transfers.toLocaleString()}
              sub={<Delta value={data.agg_transfers_delta} />}
            />
            <KpiCard
              label="Total Volume"
              value={fmtMoney(data.agg_volume)}
              sub={<Delta value={data.agg_volume_delta} money />}
            />
            <KpiCard
              label="Net Over/Short"
              value={`${data.agg_over_short >= 0 ? "+" : "-"}${fmtMoney(Math.abs(data.agg_over_short))}`}
              sub={<Delta value={data.agg_over_short_delta} money />}
              tone={data.agg_over_short < 0 ? "negative" : "neutral"}
            />
            <KpiCard
              label="Stores"
              value={data.store_count.toLocaleString()}
            />
          </KpiGrid>

          {data.series_labels.length > 0 && (
            <Section title="Volume trend">
              <Card>
                <div className={styles.chartHost}>
                  <Line
                    data={{
                      labels: data.series_labels,
                      datasets: [{
                        label: "Volume ($)",
                        data: data.series_volume,
                        borderColor: chartSeries().accent,
                        backgroundColor: seriesFill("positive", 0.1),
                        fill: true,
                        tension: 0.25,
                        pointRadius: 0,
                      }],
                    }}
                    options={moneyChartOptions("Volume")}
                  />
                </div>
              </Card>
            </Section>
          )}

          <Section title="Stores">
            <div className={styles.storeGrid}>
              {data.stores.map((s) => (
                <AppLink key={s.id} to={`/owner/store/${s.id}`} className={styles.storeCard}>
                  <div className={styles.storeName}>{s.name}</div>
                  <div className={styles.storeMeta}>
                    {fmtNumber(s.count)} transfers ·{" "}
                    {fmtMoney(s.volume)}
                  </div>
                  <div className={styles.storeOver}>
                    {s.over_short >= 0 ? "+" : "-"}{fmtMoney2(Math.abs(s.over_short))} over/short
                  </div>
                </AppLink>
              ))}
              {data.stores.length === 0 && (
                <Empty>No stores linked yet.</Empty>
              )}
            </div>
          </Section>

          {data.company_breakdown.length > 0 && (
            <Section title={`Company breakdown (${data.prev_label})`}>
              <Table>
                <thead>
                  <tr>
                    <th style={thStyle}>Company</th>
                    <th style={thStyleRight}>Transfers</th>
                    <th style={thStyleRight}>Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {data.company_breakdown.map((c) => (
                    <tr key={c.company}>
                      <td style={tdStyle}>{c.company}</td>
                      <td style={tdStyleRight}>{c.count.toLocaleString()}</td>
                      <td style={tdStyleRight}>{fmtMoney(c.volume)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Section>
          )}
        </>
      )}
    </PageShell>
  );
}
