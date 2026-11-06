
import { useDashboardSummary, type SuperadminDashboard } from "../api/dashboard";
import { fmtMoney, fmtNumber } from "../lib/formatters";
import { AppLink,
  ErrorState, KpiCard, KpiGrid, Loading, PageHeader, PageShell, Section,
} from "../components/ui";
import styles from "./SuperadminControls.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/superadmin/controls — Platform hub. KPI tiles fed by the
// superadmin answer of /api/v2/dashboard/summary (exactly these ten
// figures; the full platform BI is /api/v2/superadmin/dashboard),
// plus quick links into the dedicated SPA routes for Stores, Audit
// Log, Announcements, Reports, Feature Flags, and Discounts.
// TV catalog curation is the only remaining "Coming soon" item.

export default function SuperadminControls() {
  const t = useT();
  const { data, isLoading, isError, refetch } = useDashboardSummary();
  const d: SuperadminDashboard | null =
    data?.role === "superadmin" ? data : null;

  return (
    <PageShell gap="1.25rem">

      <PageCrumbs />

      <PageHeader
        title={navWord("Controls")}
        subtitle={t("saCtl.subtitle")}
      />

      {isLoading && <Loading label={t("saCtl.loading")} />}
      {isError && (
        <ErrorState
          message={t("saCtl.loadFailed")}
          onRetry={() => { void refetch(); }}
        />
      )}

      {d && (
        <Section title={t("saCtl.overview")}>
          <KpiGrid minWidth="180px">
            <KpiCard
              label={t("saCtl.totalStores")}
              value={fmtNumber(d.total_stores)}
              tone="primary"
            />
            <KpiCard
              label={t("common.active")}
              value={fmtNumber(d.active_stores)}
              tone="positive"
            />
            <KpiCard label={t("saCtl.trial")} value={fmtNumber(d.trial_stores)} tone="warning" />
            <KpiCard label={t("saCtl.paid")} value={fmtNumber(d.paid_stores)} tone="positive" />
            <KpiCard
              label={t("common.inactive")}
              value={fmtNumber(d.inactive_stores)}
              tone={d.inactive_stores > 0 ? "negative" : "primary"}
            />
            <KpiCard
              label={t("saCtl.retention")}
              value={fmtNumber(d.retention_queue)}
              tone={d.retention_queue > 0 ? "warning" : "primary"}
            />
            <KpiCard
              label="MRR"
              value={fmtMoney(d.mrr_total)}
              tone="primary"
            />
            <KpiCard
              label="ARR"
              value={fmtMoney(d.arr_total)}
              tone="primary"
            />
            <KpiCard
              label={t("saCtl.new30")}
              value={fmtNumber(d.new_stores_30d)}
              tone="positive"
            />
            <KpiCard
              label={t("saCtl.cancel30")}
              value={fmtNumber(d.cancellations_30d)}
              tone={d.cancellations_30d > 0 ? "negative" : "primary"}
            />
          </KpiGrid>
        </Section>
      )}

      <Section title={t("saCtl.hubs")}>
        <div className={styles.quickLinkGrid}>
          <QuickLink
            to="/superadmin/stores"
            title={navWord("Stores")}
            desc={t("saCtl.storesDesc")}
          />
          <QuickLink
            to="/superadmin/audit-log"
            title={navWord("Audit log")}
            desc={t("saCtl.auditDesc")}
          />
          <QuickLink
            to="/superadmin/announcements"
            title={navWord("Announcements")}
            desc={t("saCtl.announceDesc")}
          />
          <QuickLink
            to="/superadmin/reports"
            title={navWord("Platform reports")}
            desc={t("saCtl.reportsDesc")}
          />
          <QuickLink
            to="/superadmin/discounts"
            title={navWord("Discounts")}
            desc={t("saCtl.discountsDesc")}
          />
          <QuickLink
            to="/superadmin/feature-flags"
            title={navWord("Feature flags")}
            desc={t("saCtl.flagsDesc")}
          />
          <ComingSoon
            title={t("saCtl.tv")}
            desc={t("saCtl.tvDesc")}
          />
        </div>
      </Section>
    </PageShell>
  );
}


function ComingSoon({ title, desc }: { title: string; desc: string }) {
  const t = useT();
  return (
    <div className={styles.quickLinkDisabled}>
      <div className={styles.quickLinkTitleRow}>
        {title}
        <span className={styles.comingPill}>{t("reports.comingSoon")}</span>
      </div>
      <div className={styles.muted}>{desc}</div>
    </div>
  );
}

function QuickLink({
  to, title, desc,
}: { to: string; title: string; desc: string }) {
  return (
    <AppLink to={to} className={styles.quickLink}>
      <div className={styles.quickLinkTitle}>{title}</div>
      <div className={styles.muted}>{desc}</div>
    </AppLink>
  );
}
