import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  BarElement,
  ArcElement,
} from "chart.js";
import { Bar, Doughnut, Line } from "react-chartjs-2";

import { apiErrorMessage } from "../lib/api";
import { fmtMoney, fmtNumber } from "../lib/formatters";
import {
  useSuperadminDashboard,
  type ActivityEntry,
  type VolumeByCompany,
} from "../api/superadmin";
import {
  chartSeries, chartTokens, countChartOptions, moneyChartOptions, seriesFill,
} from "../lib/chartOptions";
import {
  Card,
  EmptyState,
  ErrorState,
  KpiCard,
  KpiGrid,
  Loading,
  PageHeader,
  PageShell,
  Pill,
  Section,
} from "../components/ui";
import styles from "./SuperadminDashboard.module.css";
import { planLabel } from "../api/billing";
import { formatDateTime, formatShortDate } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { t as translate, tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// A product word: the same in every language.
const MRR = "MRR";

// The server's activity words; one it adds later shows as sent.
const ACTIVITY_KINDS: Record<string, MessageKey> = {
  signup: "saDash.kind.signup",
  cancel: "saDash.kind.cancel",
};
const ACTIVITY_DETAILS: Record<string, MessageKey> = {
  "via referral": "saDash.detail.referral",
  "direct signup": "saDash.detail.direct",
  "canceled subscription": "saDash.detail.canceled",
};

function lookup(map: Record<string, MessageKey>, value: string): string {
  return Object.hasOwn(map, value) ? translate(map[value]) : value;
}

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, ArcElement, Filler, Legend, Title, Tooltip,
);


export default function SuperadminDashboard() {
  const t = useT();
  const { data, isLoading, isError, error, refetch } = useSuperadminDashboard();

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />

      <PageHeader
        title={navWord("Dashboard")}
        subtitle={t("saDash.subtitle")}
      />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={apiErrorMessage(error, t("saDash.loadFailed"))}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <>
          <KpiGrid>
            <KpiCard
              label={t("saCtl.totalStores")}
              value={fmtNumber(data.total_stores)}
            />
            <KpiCard
              label={t("saDash.activeStores")}
              value={fmtNumber(data.active_count)}
              tone="positive"
            />
            <KpiCard
              label={t("saDash.trialStores")}
              value={fmtNumber(data.trial_count)}
              tone="warning"
            />
            <KpiCard
              label={t("saDash.paidStores")}
              value={fmtNumber(data.paid_count)}
              tone="positive"
            />
            <KpiCard
              label={MRR}
              value={fmtMoney(data.estimated_mrr)}
              tone="positive"
            />
            <KpiCard
              label={t("saCtl.new30")}
              value={fmtNumber(data.new_stores_30d)}
              sub={t("saDash.vsPrior", {
                delta: data.new_stores_delta >= 0
                  ? `+${fmtNumber(data.new_stores_delta)}` : fmtNumber(data.new_stores_delta),
              })}
              tone={data.new_stores_delta >= 0 ? "positive" : "negative"}
            />
            <KpiCard
              label={t("saDash.churn30")}
              value={fmtNumber(data.churn_30d)}
              sub={t("saDash.vsPrior", {
                delta: data.churn_delta <= 0
                  ? fmtNumber(data.churn_delta) : `+${fmtNumber(data.churn_delta)}`,
              })}
              tone={data.churn_delta <= 0 ? "positive" : "negative"}
            />
            <KpiCard
              label={t("saDash.volume30")}
              value={fmtMoney(data.total_volume_30d)}
              sub={tn("saDash.transfers", data.total_transfers_30d, fmtNumber)}
            />
          </KpiGrid>

          <div className={styles.chartRow}>
            <Section title={t("saDash.signupTrend")}>
              <Card>
                <div className={styles.chartWrap}>
                  <SignupChart
                    labels={data.signup_labels}
                    direct={data.signup_direct}
                    referral={data.signup_referral}
                  />
                </div>
              </Card>
            </Section>

            <Section title={t("saDash.planBreakdown")}>
              <Card>
                <div className={styles.chartWrap}>
                  <PlanDoughnut
                    trial={data.trial_count}
                    basic={data.basic_count}
                    pro={data.pro_count}
                    inactive={data.inactive_count}
                  />
                </div>
              </Card>
            </Section>
          </div>

          <Section title={t("saDash.mrrTrend")}>
            <Card>
              <div className={styles.chartWrap}>
                <MrrTrendChart
                  labels={data.mrr_trend.labels}
                  values={data.mrr_trend.values}
                />
              </div>
            </Card>
          </Section>

          <div className={styles.chartRow}>
            <Section title={t("saDash.volumeByCompany")}>
              <Card>
                <div className={styles.chartWrap}>
                  <VolumeBar rows={data.volume_by_company} />
                </div>
              </Card>
            </Section>

            <Section title={t("saDash.mrrBreakdown")}>
              <Card>
                <KpiGrid minWidth="10rem">
                  <MrrRow label={t("saDash.basicMonthly")} count={data.basic_monthly} mrr={data.basic_monthly_mrr} />
                  <MrrRow label={t("saDash.basicYearly")} count={data.basic_yearly} mrr={data.basic_yearly_mrr} />
                  <MrrRow label={t("saDash.proMonthly")} count={data.pro_monthly} mrr={data.pro_monthly_mrr} />
                  <MrrRow label={t("saDash.proYearly")} count={data.pro_yearly} mrr={data.pro_yearly_mrr} />
                  <KpiCard
                    label={t("saDash.totalMrr")}
                    value={fmtMoney(data.estimated_mrr)}
                    tone="positive" colorValue
                  />
                </KpiGrid>
              </Card>
            </Section>
          </div>

          <Section title={t("saDash.recent")}>
            <Card>
              {data.activity.length === 0 ? (
                <EmptyState
                  title={t("saDash.noActivity")}
                  body={t("saDash.noActivityBody")}
                />
              ) : (
                <div className={styles.activityList}>
                  {data.activity.map((a, i) => (
                    <ActivityRow key={i} entry={a} />
                  ))}
                </div>
              )}
            </Card>
          </Section>
        </>
      )}
    </PageShell>
  );
}


function SignupChart({
  labels, direct, referral,
}: {
  labels: string[];
  direct: number[];
  referral: number[];
}) {
  useT();
  const tk = chartTokens();
  const s = chartSeries();
  const options = countChartOptions(translate("saDash.signups"));
  const shortLabels = labels.map((l) => formatShortDate(l));
  return (
    <Line
      data={{
        labels: shortLabels,
        datasets: [
          {
            label: translate("saDash.direct"),
            data: direct,
            borderColor: s.accent,
            backgroundColor: seriesFill("positive", 0.1),
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4,
          },
          {
            label: translate("saDash.referral"),
            data: referral,
            borderColor: s.info,
            backgroundColor: seriesFill("info", 0.08),
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4,
          },
        ],
      }}
      options={{
        ...options,
        plugins: {
          ...options.plugins,
          legend: {
            display: true,
            labels: { color: tk.textMuted, boxWidth: 12 },
          },
        },
      }}
    />
  );
}


function PlanDoughnut({
  trial, basic, pro, inactive,
}: {
  trial: number; basic: number; pro: number; inactive: number;
}) {
  useT();
  const t = chartTokens();
  const s = chartSeries();
  return (
    <Doughnut
      data={{
        labels: [planLabel("trial"), planLabel("basic"), planLabel("pro"), planLabel("inactive")],
        datasets: [{
          data: [trial, basic, pro, inactive],
          backgroundColor: [
            s.warning,
            s.accent,
            s.info,
            s.neutral,
          ],
          borderColor: "transparent",
          borderWidth: 0,
        }],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        cutout: "60%",
        plugins: {
          legend: {
            display: true,
            position: "bottom",
            labels: { color: t.textMuted, padding: 16 },
          },
          tooltip: {
            backgroundColor: t.surface2,
            titleColor: t.text,
            bodyColor: t.text,
            borderColor: t.border,
            borderWidth: 1,
          },
        },
      }}
    />
  );
}


function MrrTrendChart({ labels, values }: { labels: string[]; values: number[] }) {
  const s = chartSeries();
  return (
    <Line
      data={{
        labels,
        datasets: [{
          label: MRR,
          data: values,
          borderColor: s.accent,
          backgroundColor: seriesFill("positive", 0.1),
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 6,
        }],
      }}
      options={moneyChartOptions(MRR)}
    />
  );
}


function VolumeBar({ rows }: { rows: VolumeByCompany[] }) {
  useT();
  const t = chartTokens();
  const s = chartSeries();
  const volume = translate("saDash.volume");
  const options = moneyChartOptions<"bar">(volume);
  return (
    <Bar
      data={{
        labels: rows.map((r) => r.company),
        datasets: [{
          label: volume,
          data: rows.map((r) => r.total),
          backgroundColor: seriesFill("positive", 0.6),
          borderColor: s.accent,
          borderWidth: 1,
          borderRadius: 4,
        }],
      }}
      options={{
        ...options,
        plugins: {
          ...options.plugins,
          legend: {
            display: false,
            labels: { color: t.textMuted },
          },
        },
      }}
    />
  );
}


function MrrRow({ label, count, mrr }: { label: string; count: number; mrr: number }) {
  const t = useT();
  return (
    <KpiCard
      label={label}
      value={t("saDash.perMonth", { amount: fmtMoney(mrr) })}
      sub={tn("saStores.stores", count, fmtNumber)}
    />
  );
}


function ActivityRow({ entry: a }: { entry: ActivityEntry }) {
  useT();
  return (
    <div className={styles.activityRow}>
      <Pill tone={a.kind === "signup" ? "accent" : "negative"}>
        {lookup(ACTIVITY_KINDS, a.kind)}
      </Pill>
      <span className={styles.activityStore}>{a.store_name}</span>
      <span className={styles.activityDetail}>{lookup(ACTIVITY_DETAILS, a.detail)}</span>
      <span className={styles.activityTime}>{formatDateTime(a.when)}</span>
    </div>
  );
}
