import { useSuperadminReports } from "../api/superadmin";
import ReportCenter from "../components/ReportCenter";
import {
  ErrorState, Loading, PageHeader, PageShell } from "../components/ui";
import { ApiError, apiErrorMessage } from "../lib/api";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/superadmin/reports — platform-wide report center index.
//
// Wires the shared ReportCenter component to the superadmin-scoped
// JSON envelope at /api/v2/superadmin/reports. Drilldown URLs still
// point at Flask paths (/superadmin/reports/<slug>) — each report's
// per-page render migrates separately.

export default function SuperadminReports() {
  const t = useT();
  const { data, isLoading, isError, error, refetch } = useSuperadminReports();
  const title = navWord("Platform reports");

  if (isLoading) {
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title={title} />
        <Loading />
      </PageShell>
    );
  }
  if (isError || !data) {
    const status = error instanceof ApiError ? error.status : 0;
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title={title} />
        <ErrorState
          message={
            status === 403
              ? t("sa.scopeRequired")
              : t("saReports.loadFailed", { reason: apiErrorMessage(error, "") }).trim()
          }
          onRetry={status === 403 ? undefined : () => { void refetch(); }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageCrumbs />
      <ReportCenter title={title} categories={data.categories} />
    </PageShell>
  );
}
