import { useSuperadminReports } from "../api/superadmin";
import { ReportCenterPage } from "../components/ReportCenter";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/superadmin/reports — platform-wide report center index, from
// the superadmin-scoped registry at /api/v2/superadmin/reports.

export default function SuperadminReports() {
  const t = useT();
  return (
    <ReportCenterPage
      title={navWord("Platform reports")}
      list={useSuperadminReports()}
      scopeMessage={t("sa.scopeRequired")}
      failedMessage={(reason) => t("saReports.loadFailed", { reason })}
    />
  );
}
