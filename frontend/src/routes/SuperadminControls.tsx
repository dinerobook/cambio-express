
import { useDashboardSummary, type SuperadminDashboard } from "../api/dashboard";
import { fmtMoney, fmtNumber } from "../lib/formatters";
import { AppLink,
  ErrorState, KpiCard, KpiGrid, Loading, PageHeader, PageShell, Section,
} from "../components/ui";
import styles from "./SuperadminControls.module.css";
import { PageCrumbs } from "../components/PageCrumbs";

// /app/superadmin/controls — Platform hub. KPI tiles fed by the
// superadmin answer of /api/v2/dashboard/summary (exactly these ten
// figures; the full platform BI is /api/v2/superadmin/dashboard),
// plus quick links into the dedicated SPA routes for Stores, Audit
// Log, Announcements, Reports, Feature Flags, and Discounts.
// TV catalog curation is the only remaining "Coming soon" item.

export default function SuperadminControls() {
  const { data, isLoading, isError, refetch } = useDashboardSummary();
  const d: SuperadminDashboard | null =
    data?.role === "superadmin" ? data : null;

  return (
    <PageShell gap="1.25rem">

      <PageCrumbs />

      <PageHeader
        title="Controls"
        subtitle="Stores, billing, anomalies, audit log, announcements, reports."
      />

      {isLoading && <Loading label="Loading platform metrics…" />}
      {isError && (
        <ErrorState
          message="Couldn't load metrics for the overview."
          onRetry={() => { void refetch(); }}
        />
      )}

      {d && (
        <Section title="Overview">
          <KpiGrid minWidth="180px">
            <KpiCard
              label="Total stores"
              value={fmtNumber(d.total_stores)}
              tone="primary"
            />
            <KpiCard
              label="Active"
              value={fmtNumber(d.active_stores)}
              tone="positive"
            />
            <KpiCard label="Trial" value={fmtNumber(d.trial_stores)} tone="warning" />
            <KpiCard label="Paid" value={fmtNumber(d.paid_stores)} tone="positive" />
            <KpiCard
              label="Inactive"
              value={fmtNumber(d.inactive_stores)}
              tone={d.inactive_stores > 0 ? "negative" : "primary"}
            />
            <KpiCard
              label="Retention queue"
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
              label="New (30d)"
              value={fmtNumber(d.new_stores_30d)}
              tone="positive"
            />
            <KpiCard
              label="Cancellations (30d)"
              value={fmtNumber(d.cancellations_30d)}
              tone={d.cancellations_30d > 0 ? "negative" : "primary"}
            />
          </KpiGrid>
        </Section>
      )}

      <Section title="Hubs">
        <div className={styles.quickLinkGrid}>
          <QuickLink
            to="/superadmin/stores"
            title="Stores"
            desc="Browse, filter, edit. Per-store impersonate / extend / toggle."
          />
          <QuickLink
            to="/superadmin/audit-log"
            title="Audit log"
            desc="Every platform admin action. Filter by actor / target / action."
          />
          <QuickLink
            to="/superadmin/announcements"
            title="Announcements"
            desc="Global banners + push notifications across every store."
          />
          <QuickLink
            to="/superadmin/reports"
            title="Platform reports"
            desc="MRR/ARR, churn cohorts, adoption, payouts."
          />
          <QuickLink
            to="/superadmin/discounts"
            title="Discounts"
            desc="Coupon codes — toggle visibility, view redemptions."
          />
          <QuickLink
            to="/superadmin/feature-flags"
            title="Feature flags"
            desc="Platform-wide flags + per-store overrides."
          />
          <ComingSoon
            title="TV catalogs"
            desc="Curate the company and bank pickers shown on TV displays."
          />
        </div>
      </Section>
    </PageShell>
  );
}


function ComingSoon({ title, desc }: { title: string; desc: string }) {
  return (
    <div className={styles.quickLinkDisabled}>
      <div className={styles.quickLinkTitleRow}>
        {title}
        <span className={styles.comingPill}>Coming soon</span>
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
