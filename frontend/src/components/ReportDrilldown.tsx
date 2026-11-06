import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import {
  defaultStoreIds, useReportDrilldown,
  type AggregatedRow, type AggregatedTotals,
} from "../api/reportDrilldown";
import { downloadCsv, apiErrorMessage } from "../lib/api";
import {
  Button, DateInput, EmptyState, ErrorState, KpiCard,
  KpiGrid, PageHeader, PageShell, TableSkeleton, tdStyle, thStyle,
} from "./ui";
import styles from "./ReportDrilldown.module.css";
import { formatDate, monthStartIso, todayIso } from "../lib/datetime";
import { PageCrumbs } from "./PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import {
  t, tn, useT, type MessageKey, type MessageVars, type PluralBase,
} from "../i18n";

// Every word a report page hands in is a key (`rep.*`,
// `reportName.*`): this component says it in the person's language.
// Row values are the server's and show as sent.

export interface KpiSpec {
  label: MessageKey;
  /** Placeholders in the label ("Above {amount}"). */
  labelVars?: MessageVars;
  tone?: "primary" | "neon" | "muted" | "warning" | "negative";
  // Extracted from totals.
  value: (totals: AggregatedTotals) => React.ReactNode;
}

export interface ColumnSpec {
  label: MessageKey;
  // Field name on the row OR a render function.
  field: keyof AggregatedRow | ((r: AggregatedRow) => React.ReactNode);
  align?: "left" | "right";
  mono?: boolean;
}

interface ReportDrilldownProps {
  // API path slug ("sales-by-company", "cashier-productivity", …).
  apiSlug: string;
  // Page title (the report's name in the registry, `reportName.*`).
  title: MessageKey;
  // The result count's noun ("3 companies"), a `.one` / `.other` pair.
  resultUnit: PluralBase;
  // KPI strip across the top.
  kpis: KpiSpec[];
  // Column config for the row table.
  columns: ColumnSpec[];
  // CSV export URL (Flask). Caller passes the resolved URL so each
  // drilldown can point at /reports/<slug>.csv or
  // /owner/reports/<slug>.csv.
  csvUrl: string;
  // Back link target — /app/reports or /app/owner/reports.
  backTo: string;
  // Extra query params for the API (e.g. `{sort_by: "count"}`).
  // The CSV link receives them too so the export matches the view.
  extraParams?: Record<string, string>;
}

export function ReportDrilldown({
  apiSlug, title, resultUnit, kpis, columns, csvUrl, backTo,
  extraParams,
}: ReportDrilldownProps) {
  useT(); // re-render on a language switch
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState(() => params.get("from") || monthStartIso());
  const [to, setTo] = useState(() => params.get("to") || todayIso());

  // Sync `from`/`to` back into the URL so the report is shareable.
  useEffect(() => {
    const next = new URLSearchParams(params);
    next.set("from", from);
    next.set("to", to);
    setParams(next, { replace: true });
  }, [from, to]);  // eslint-disable-line react-hooks/exhaustive-deps

  const storeIds = defaultStoreIds();
  const { data, isLoading, isError, error, refetch } = useReportDrilldown({
    apiSlug, from, to, storeIds, extraParams,
  });

  const rowCount = data?.rows.length ?? 0;

  // Append the period (+ store_ids + any extraParams) to the CSV
  // URL so the download matches the visible filter. The FastAPI
  // endpoint reads the same query params as the JSON drilldown.
  const csvParams = new URLSearchParams({ from, to, ...(extraParams ?? {}) });
  if (storeIds.length > 0) {
    csvParams.set("store_ids", storeIds.join(","));
  }
  const csvHref = `${csvUrl}?${csvParams.toString()}`;

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs under={backTo} current={t(title)} />
      <div>
        <PageHeader
          title={t(title)}
          actions={(
            <div className={styles.actionRow}>
              <form
                style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  // useEffect already syncs to URL — submitting is a noop.
                }}
              >
                <label className={styles.inputLabel}>
                  <span>{t("rep.from")}</span>
                  <DateInput
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className={styles.dateInput}
                  />
                </label>
                <label className={styles.inputLabel}>
                  <span>{t("rep.to")}</span>
                  <DateInput
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className={styles.dateInput}
                  />
                </label>
              </form>
              <Button
                tone="secondary" size="sm"
                onClick={() => {
                  void downloadCsv(csvHref, csvFilename(csvUrl, from, to));
                }}
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

      {storeIds.length === 0 && (
        <p className={styles.muted}>
          {t("rep.signIn")}
        </p>
      )}

      {data && (
        <KpiGrid minWidth="180px">
          {kpis.map((k) => (
            <KpiCard
              key={k.label}
              label={t(k.label, k.labelVars)}
              value={k.value(data.totals)}
              tone={k.tone ?? "neutral"}
            />
          ))}
        </KpiGrid>
      )}

      <div className={styles.filterRow}>
        <span className={styles.muted}>
          {formatDate(from)} – {formatDate(to)}
        </span>
        {data && (
          <span className={styles.muted}>
            {tn(resultUnit, rowCount, fmtNumber)}
          </span>
        )}
      </div>

      {isLoading && <TableSkeleton rows={5} cols={columns.length || 4} />}
      {isError && (
        <ErrorState
          message={t("rep.loadFailed", {
            error: apiErrorMessage(error, t("rep.unknownError")),
          })}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && data.rows.length === 0 && (
        <EmptyState title={t("rep.noData")} />
      )}

      {data && data.rows.length > 0 && (
        <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.label}
                  style={{
                    ...thStyle,
                    textAlign: c.align ?? (c.mono ? "right" : "left"),
                  }}
                >
                  {t(c.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => {
                  const value =
                    typeof c.field === "function"
                      ? c.field(r)
                      : r[c.field];
                  return (
                    <td
                      key={c.label}
                      style={{
                        ...tdStyle,
                        textAlign: c.align ?? (c.mono ? "right" : "left"),
                        fontFamily: c.mono ? "var(--db-font-mono)" : undefined,
                      }}
                    >
                      {value as React.ReactNode}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </PageShell>
  );
}

// Derive a filename from the CSV URL slug + period. Mirrors the
// `fname_prefix_<from>_<to>.csv` shape the backend's
// `Content-Disposition` header produces, but we generate it on
// the client so a slow network doesn't block the download UX.
function csvFilename(url: string, from: string, to: string): string {
  const path = url.split("?")[0];
  const slug = path.split("/").pop()?.replace(/\.csv$/, "") || "report";
  return `${slug}_${from}_${to}.csv`;
}

