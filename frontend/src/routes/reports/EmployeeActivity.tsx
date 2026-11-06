import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function EmployeeActivity() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="employee-activity"
      title="reportName.employee_activity"
      resultUnit="rep.unit.employee"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/employee-activity.csv`}
      kpis={[
        { label: "rep.transfersLogged", tone: "primary",
          value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "rep.totalSent",       tone: "neon",
          value: t => fmtMoney2(Number(t.sent ?? 0)) },
        { label: "rep.employeesActive", tone: "muted",
          value: t => fmtNumber(Number(t.employees ?? 0)) },
      ]}
      columns={[
        { label: "rep.employee",   field: "employee" },
        { label: "rep.transfers",  field: r => fmtNumber(Number(r.count ?? 0)), align: "right", mono: true },
        { label: "rep.totalSent", field: r => fmtMoney2(Number(r.sent ?? 0)),         align: "right", mono: true },
        { label: "rep.firstLogged", field: r => (r.first_logged as string) || "—" },
        { label: "rep.lastLogged",  field: r => (r.last_logged as string) || "—"  },
      ]}
    />
  );
}
