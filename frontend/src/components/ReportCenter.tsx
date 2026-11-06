import { useState } from "react";

import {
  ButtonLink, Card, Input, PageHeader, Pill, EmptyState,
} from "./ui";
import styles from "./ReportCenter.module.css";
import { t, useLanguage, type MessageKey } from "../i18n";
import { en } from "../i18n/en";

// Shared report-center used by /app/reports, /app/owner/reports,
// and /app/superadmin/reports. Renders a search box in the
// PageHeader actions slot + one card per category with report rows
// inside.

export interface ReportRow {
  key: string;
  label: string;
  description: string;
  url: string | null;
  status: string;  // "ready" | "coming_soon"
}

export interface ReportCategoryRow {
  key: string;
  label: string;
  icon: string;  // inline stroke SVG
  reports: ReportRow[];
}

/** A registry word in the person's language. The registry is server
 *  text; a key we ship words for (`reportCat.<key>`,
 *  `reportName.<key>`, `reportDesc.<key>`) is translated, a key we
 *  don't (a report added server-side first) shows as sent. */
function registryWord(key: string, sent: string): string {
  return Object.hasOwn(en, key) ? t(key as MessageKey) : sent;
}

const catLabel = (c: ReportCategoryRow) =>
  registryWord(`reportCat.${c.key}`, c.label);
const reportLabel = (r: ReportRow) =>
  registryWord(`reportName.${r.key}`, r.label);
const reportDescription = (r: ReportRow) =>
  registryWord(`reportDesc.${r.key}`, r.description);

export default function ReportCenter({
  title, categories,
}: {
  /** The page's sidebar name ("MSB reports", "Platform reports"…). */
  title: string;
  categories: ReportCategoryRow[];
}) {
  const [query, setQuery] = useState("");
  useLanguage(); // re-render on a language switch

  // Worked out on every render (a few dozen rows): the search reads
  // the words on screen, which change with the language.
  const filtered = (() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return categories.map((c) => ({ ...c, hits: c.reports.length }));
    }
    return categories.map((c) => {
      const hits = c.reports.filter((r) =>
        reportLabel(r).toLowerCase().includes(q)
        || reportDescription(r).toLowerCase().includes(q),
      );
      return { ...c, reports: hits, hits: hits.length };
    }).filter((c) => c.hits > 0);
  })();

  const anyVisible = filtered.length > 0;

  return (
    <section>
      <PageHeader
        title={title}
        actions={(
          <div className={styles.searchBox}>
            <Input
              type="search"
              placeholder={t("reports.search")}
              autoComplete="off"
              aria-label={t("reports.searchAria")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
      />

      {!anyVisible && (
        <EmptyState title={t("reports.noMatch")} />
      )}

      <div className={styles.catGrid}>
        {filtered.map((cat) => (
          <CategoryCard
            key={cat.key} cat={cat}
            forceOpen={!!query.trim() && cat.hits > 0}
          />
        ))}
      </div>
    </section>
  );
}


function CategoryCard({
  cat, forceOpen,
}: {
  cat: ReportCategoryRow & { hits?: number };
  forceOpen: boolean;
}) {
  return (
    <Card padding="0">
      <details open={forceOpen || undefined} className={styles.cat}>
        <summary className={styles.summary}>
          <span className={styles.icon}
                dangerouslySetInnerHTML={{ __html: cat.icon }} />
          <span className={styles.catLabel}>{catLabel(cat)}</span>
          <Pill tone="neutral">{cat.reports.length}</Pill>
          <span className={styles.caret} aria-hidden="true">
            <svg viewBox="0 0 24 24" stroke="currentColor" fill="none"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                 width="14" height="14">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </span>
        </summary>
        <div className={styles.catBody}>
          {cat.reports.map((r) => <ReportRowView key={r.key} report={r} />)}
        </div>
      </details>
    </Card>
  );
}


function ReportRowView({ report }: { report: ReportRow }) {
  const ready = report.status === "ready" && !!report.url;
  return (
    <div className={styles.row}>
      <div className={styles.rowBody}>
        <div className={styles.rowName}>{reportLabel(report)}</div>
        <div className={styles.rowDesc}>{reportDescription(report)}</div>
      </div>
      <div>
        {ready
          ? <ButtonLink to={report.url ?? "#"} size="sm">{t("reports.view")}</ButtonLink>
          : <Pill tone="info">{t("reports.comingSoon")}</Pill>}
      </div>
    </div>
  );
}
