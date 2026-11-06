import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";

import { api, downloadCsv, apiErrorMessage } from "../../lib/api";
import { chartSeries, countChartOptions, moneyChartOptions, seriesFill } from "../../lib/chartOptions";
import { Button, Card, DateInput, EmptyState, ErrorState, KpiCard, KpiGrid,
  PageHeader, PageShell, TableSkeleton, tdStyle, thStyle, tokens,
} from "../../components/ui";
import styles from "./SuperadminBIDrilldown.module.css";
import {
  formatShortDate, monthStartIso, todayIso,
} from "../../lib/datetime";
import { PageCrumbs } from "../../components/PageCrumbs";
import { fmtNumber } from "../../lib/formatters";
import { t as translate, tn, useT, type MessageKey } from "../../i18n";

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, Filler, Tooltip,
);

// Generic React shell for all superadmin BI drilldowns. The legacy
// Jinja drilldowns shared the same shape (KPI strip + period filter
// + paginated row table); rather than build one TSX wrapper per
// report (20 reports → 20 files), this single component reads the
// `{rows, totals}` envelope from /api/v2/superadmin/reports/<slug>
// and auto-derives KPIs from totals and columns from the first row.
//
// Chart auto-detection
// --------------------
// We render a Line or Bar chart above the table when the row shape
// permits it:
//   - Line: first row has a date-like identity key (date / month /
//           period / day / bucket-of-dates). x = identity, y =
//           first numeric column. Good for trends (signup-funnel,
//           dau-mau, churn-cohort, login-activity).
//   - Bar:  no date key but a single string identity column +
//           single numeric value column. Good for categorical
//           breakdowns (active-stores-by-plan, mrr-arr, payouts,
//           bank-sync-adoption).
//   - Skip: <2 or >40 rows (too cluttered or too sparse), or
//           ambiguous shapes. Falls through to table-only render.
//
// Per-report title comes from `TITLE_KEYS`. Anything not in the
// lookup falls back to a humanized slug. Column and total names are
// the server's field names, humanized: they stay as sent.

// URL slug → the report center's `reportName.<key>`, so a report
// reads the same name in the list and on its own page.
const TITLE_KEYS: Record<string, MessageKey> = {
  "active-stores-by-plan":   "reportName.active_stores_by_plan",
  "signup-funnel":           "reportName.signup_funnel",
  "login-activity":          "reportName.login_activity",
  "mrr-arr":                 "reportName.mrr_arr",
  "churn-cohort":            "reportName.churn",
  "conversion-rate":         "reportName.conversion_rate",
  "time-to-convert":         "reportName.time_to_convert",
  "trial-expiry-timing":     "reportName.trial_expiry_timing",
  "bank-sync-adoption":      "reportName.bank_sync_adoption",
  "tv-display-adoption":     "reportName.tv_display_adoption",
  "owner-adoption":          "reportName.owner_adoption",
  "passkey-adoption":        "reportName.passkey_adoption",
  "password-resets":         "reportName.password_resets",
  "suspended-stores":        "reportName.suspended_stores",
  "retention-queue":         "reportName.retention_queue",
  "refunds":                 "reportName.refunds",
  "failed-payments":         "reportName.failed_payments",
  "payouts":                 "reportName.payouts",
  "dau-mau":                 "reportName.dau_mau",
  "webhook-health":          "reportName.webhook_health",
};

interface Envelope {
  rows: Array<Record<string, unknown>>;
  totals: Record<string, unknown>;
  [extra: string]: unknown;
}

type ViewMode = "both" | "chart" | "table";

const VIEW_MODE_KEY_PREFIX = "dinerobook.bi.view-mode.";

function loadViewMode(slug: string): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY_PREFIX + slug);
    if (v === "chart" || v === "table" || v === "both") return v;
  } catch {
    /* localStorage blocked (private mode etc.) — fall through */
  }
  return "both";
}

function saveViewMode(slug: string, mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY_PREFIX + slug, mode);
  } catch {
    /* localStorage blocked — silently ignore */
  }
}

export default function SuperadminBIDrilldown() {
  const t = useT();
  const { slug } = useParams<{ slug: string }>();
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState(() => params.get("from") || monthStartIso());
  const [to, setTo] = useState(() => params.get("to") || todayIso());
  const [data, setData] = useState<Envelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => loadViewMode(slug ?? ""),
  );

  useEffect(() => {
    if (slug) saveViewMode(slug, viewMode);
  }, [slug, viewMode]);

  useEffect(() => {
    const next = new URLSearchParams(params);
    next.set("from", from);
    next.set("to", to);
    setParams(next, { replace: true });
  }, [from, to]);   // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    api<Envelope>(
      `/api/v2/superadmin/reports/${slug}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
      .then(setData)
      .catch(e => setError(apiErrorMessage(e, translate("rep.unknownError"))))
      .finally(() => setLoading(false));
  }, [slug, from, to]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- canonical fetch-on-mount-and-deps-change: load() drives setData/setError, which is the only path to populate the report on slug/period change
    load();
  }, [load]);

  if (!slug) return null;

  const title = Object.hasOwn(TITLE_KEYS, slug) ? t(TITLE_KEYS[slug]) : humanize(slug);
  const rows = data?.rows ?? [];
  const totals = data?.totals ?? {};
  const totalKeys = Object.keys(totals).filter(
    k => k !== "current_label" && k !== "prior_label",
  );
  const rowKeys = rows.length > 0 ? Object.keys(rows[0]) : [];

  const csvHref = `/api/v2/superadmin/reports/${slug}.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const csvFilename = `${slug}_${from}_${to}.csv`;

  return (
    <PageShell gap="1.25rem">
      <div>
        <PageCrumbs current={title} />
        <PageHeader
          title={title}
          actions={(
            <div className={styles.actionRow}>
              <label className={styles.inputLabel}>
                <span>{t("rep.from")}</span>
                <DateInput
                  value={from}
                  onChange={e => setFrom(e.target.value)}
                  className={styles.dateInput}
                />
              </label>
              <label className={styles.inputLabel}>
                <span>{t("rep.to")}</span>
                <DateInput
                  value={to}
                  onChange={e => setTo(e.target.value)}
                  className={styles.dateInput}
                />
              </label>
              <Button
                tone="secondary" size="sm"
                onClick={() => { void downloadCsv(csvHref, csvFilename); }}
              >
                {t("rep.exportCsv")}
              </Button>
              <Button
                tone="secondary" size="sm"
                onClick={() => window.print()}
              >
                {t("rep.print")}
              </Button>
            </div>
          )}
        />
      </div>

      {isLoading && <TableSkeleton rows={5} cols={4} />}
      {error && (
        <ErrorState
          message={t("rep.loadFailed", { error })}
          onRetry={load}
        />
      )}

      {data && totalKeys.length > 0 && (
        <KpiGrid minWidth="180px">
          {totalKeys.map(k => (
            <KpiCard
              key={k}
              label={humanize(k)}
              value={fmtValue(totals[k])}
            />
          ))}
        </KpiGrid>
      )}

      <div className={styles.filterRow}>
        <span className={styles.muted}>{formatShortDate(from)} – {formatShortDate(to)}</span>
        {data && (
          <span className={styles.muted}>{tn("saBI.rows", rows.length, fmtNumber)}</span>
        )}
      </div>

      {data && rows.length === 0 && (
        <EmptyState title={t("rep.noData")} />
      )}

      {data && rows.length > 0 && (() => {
        const chartable = detectChart(rows) != null;
        // No chart possible → toggle hidden, always table.
        const effectiveMode: ViewMode = chartable ? viewMode : "table";
        return (
          <>
            {chartable && (
              <ViewModeToggle
                mode={viewMode}
                onChange={setViewMode}
              />
            )}
            {effectiveMode !== "table" && (
              <ChartBlock rows={rows} title={title} />
            )}
            {effectiveMode !== "chart" && (
              <div className={styles.tableWrap}>
              <table className={styles.table}>
          <thead>
            <tr>
              {rowKeys.map(k => (
                <th key={k} style={{
                  ...thStyle,
                  textAlign: isNumericKey(k, rows[0]) ? "right" : "left",
                }}>
                  {humanize(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {rowKeys.map(k => {
                  const numeric = isNumericKey(k, r);
                  return (
                    <td key={k} style={{
                      ...tdStyle,
                      textAlign: numeric ? "right" : "left",
                      fontFamily: numeric ? tokens.fontMono : undefined,
                    }}>
                      {fmtCell(k, r[k])}
                    </td>
                  );
                })}
              </tr>
            ))}
                </tbody>
              </table>
              </div>
            )}
          </>
        );
      })()}
    </PageShell>
  );
}

function isNumericKey(key: string, sample: Record<string, unknown>): boolean {
  // Treat as numeric if the sample value is a number or any cell
  // matches /\d/. Lets fallback string "—" co-exist with floats.
  const v = sample?.[key];
  return typeof v === "number";
}

// ── Chart detection + rendering ──────────────────────────────

const DATE_KEYS = new Set([
  "date", "month", "period", "day", "bucket", "week", "year",
]);
const MONEY_KEY_RE = /amount|sent|revenue|fee|mrr|arr|payout|refund|charge/i;

interface ChartPlan {
  kind: "line" | "bar";
  xKey: string;
  yKey: string;
  yLabel: string;
  yIsMoney: boolean;
}

function detectChart(rows: Array<Record<string, unknown>>): ChartPlan | null {
  if (rows.length < 2 || rows.length > 40) return null;
  const first = rows[0];
  const keys = Object.keys(first);

  // Find a numeric column for the Y axis — prefer 'amount' / 'count'
  // / 'value' over arbitrary numeric keys.
  const numericKeys = keys.filter(k => typeof first[k] === "number");
  if (numericKeys.length === 0) return null;
  const yKey =
    numericKeys.find(k => /count|total/i.test(k))
    ?? numericKeys.find(k => MONEY_KEY_RE.test(k))
    ?? numericKeys[0];

  // Date-keyed → Line chart.
  const dateKey = keys.find(k =>
    DATE_KEYS.has(k.toLowerCase())
    || /^date|date$|^month$|^period$|^day$/i.test(k),
  );
  if (dateKey && typeof first[dateKey] !== "number") {
    return {
      kind: "line",
      xKey: dateKey,
      yKey,
      yLabel: humanize(yKey),
      yIsMoney: MONEY_KEY_RE.test(yKey),
    };
  }

  // Otherwise pick a string column for the X axis → Bar.
  const stringKey = keys.find(k => typeof first[k] === "string");
  if (stringKey) {
    return {
      kind: "bar",
      xKey: stringKey,
      yKey,
      yLabel: humanize(yKey),
      yIsMoney: MONEY_KEY_RE.test(yKey),
    };
  }
  return null;
}

function ViewModeToggle({
  mode, onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  const t = useT();
  const opts: Array<{ value: ViewMode; label: MessageKey }> = [
    { value: "chart", label: "saBI.chart" },
    { value: "table", label: "saBI.table" },
    { value: "both",  label: "saBI.both"  },
  ];
  return (
    <div
      role="group"
      aria-label={t("saBI.viewMode")}
      className={styles.viewToggleGroup}
    >
      {opts.map(o => {
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={styles.viewToggleBtn}
            style={{
              background: active
                ? tokens.surface2
                : "transparent",
              color: active
                ? tokens.text
                : tokens.textMuted,
              fontWeight: active ? 600 : 400,
            }}
          >
            {t(o.label)}
          </button>
        );
      })}
    </div>
  );
}

function ChartBlock({
  rows, title,
}: {
  rows: Array<Record<string, unknown>>;
  title: string;
}) {
  const plan = detectChart(rows);
  if (!plan) return null;

  const labels = rows.map(r => String(r[plan.xKey] ?? ""));
  const series = rows.map(r => Number(r[plan.yKey] ?? 0));

  const data = {
    labels,
    datasets: [{
      label: plan.yLabel,
      data: series,
      borderColor: chartSeries().accent,
      backgroundColor: plan.kind === "line"
        ? seriesFill("positive", 0.12)
        : seriesFill("positive", 0.55),
      fill: plan.kind === "line",
      tension: 0.25,
      pointRadius: 0,
      pointHoverRadius: 4,
    }],
  };

  // chart.js types the options prop strictly per chart variant
  // (`ChartOptions<"line">` vs `ChartOptions<"bar">`). The runtime
  // shape we return is identical for both, so we resolve the right
  // generic at each call site rather than the helper trying to
  // pick a union.
  const lineOpts = plan.yIsMoney
    ? moneyChartOptions<"line">(plan.yLabel)
    : countChartOptions<"line">(plan.yLabel);
  const barOpts = plan.yIsMoney
    ? moneyChartOptions<"bar">(plan.yLabel)
    : countChartOptions<"bar">(plan.yLabel);

  return (
    <Card padding="1.25rem">
      <div aria-label={translate("saBI.chartLabel", { title })} style={{ height: 280 }}>
        {plan.kind === "line"
          ? <Line data={data} options={lineOpts} />
          : <Bar  data={data} options={barOpts} />
        }
      </div>
    </Card>
  );
}

function fmtValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") {
    // Money-ish — single number; print 2-decimal if non-integer.
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function fmtCell(key: string, v: unknown): React.ReactNode {
  if (v == null) return "—";
  if (typeof v === "number") {
    // Detect money keys by name and prepend $.
    const looksMoney = /amount|sent|revenue|fee|mrr|arr|payout|refund/i.test(key);
    const isPercent  = /pct|percent|rate|fraction/i.test(key);
    const formatted = Number.isInteger(v)
      ? v.toLocaleString()
      : v.toLocaleString(undefined, {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        });
    if (looksMoney) return `$${formatted}`;
    if (isPercent) return `${(v * (v <= 1 ? 100 : 1)).toFixed(1)}%`;
    return formatted;
  }
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function humanize(s: string): string {
  return s
    .replace(/[_-]/g, " ")
    .replace(/\bmrr\b/gi, "MRR")
    .replace(/\barr\b/gi, "ARR")
    .replace(/\bdau\b/gi, "DAU")
    .replace(/\bmau\b/gi, "MAU")
    .replace(/\b\w/g, c => c.toUpperCase());
}

