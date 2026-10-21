import { useOwnerReportList } from "../api/reports";
import ReportCenter from "../components/ReportCenter";
import {
  ErrorState, Loading, PageHeader, PageShell } from "../components/ui";
import { ApiError, apiErrorMessage } from "../lib/api";
import { PageCrumbs } from "../components/PageCrumbs";

// /app/owner/reports — owner-scoped report center index.
//
// Same registry as the per-store /app/reports, but the drilldown
// URLs route through the owner-prefix mirrors registered by
// `_register_owner_report_mirrors` in app.py — each `report_<x>`
// admin endpoint has an `owner_report_<x>` mirror that filters to
// every store under the owner umbrella.

export default function OwnerReports() {
  const { data, isLoading, isError, error, refetch } = useOwnerReportList();

  if (isLoading) {
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title="Cross-store reports" />
        <Loading />
      </PageShell>
    );
  }
  if (isError || !data) {
    const status = error instanceof ApiError ? error.status : 0;
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title="Cross-store reports" />
        <ErrorState
          message={
            status === 403
              ? "Owner scope required."
              : `Couldn't load the report list. ${apiErrorMessage(error, "")}`
          }
          onRetry={status === 403 ? undefined : () => { void refetch(); }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageCrumbs />
      <ReportCenter title={"Cross-store reports"} categories={data.categories} />
    </PageShell>
  );
}
