import { useOwnerReportList } from "../api/reports";
import { ReportCenterPage } from "../components/ReportCenter";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/owner/reports — owner-scoped report center index.
//
// Same registry as the per-store /app/reports, but the drilldown
// URLs route through the owner-prefix mirrors: each `report_<x>`
// admin endpoint has an `owner_report_<x>` mirror that filters to
// every store under the owner umbrella.

export default function OwnerReports() {
  const t = useT();
  return (
    <ReportCenterPage
      title={navWord("Cross-store reports")}
      list={useOwnerReportList()}
      scopeMessage={t("owner.scopeRequired")}
      failedMessage={(error) => t("reports.listFailed", { error })}
    />
  );
}
