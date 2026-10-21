import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function EmployeeActivity() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="employee-activity"
      title="Employee activity"
      resultUnit={["employee", "employees"]}
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/employee-activity.csv`}
      kpis={[
        { label: "Transfers logged", tone: "primary",
          value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "Total sent",       tone: "neon",
          value: t => fmtMoney2(Number(t.sent ?? 0)) },
        { label: "Employees active", tone: "muted",
          value: t => fmtNumber(Number(t.employees ?? 0)) },
      ]}
      columns={[
        { label: "Employee",   field: "employee" },
        { label: "Transfers",  field: r => fmtNumber(Number(r.count ?? 0)), align: "right", mono: true },
        { label: "Total sent", field: r => fmtMoney2(Number(r.sent ?? 0)),         align: "right", mono: true },
        { label: "First logged", field: r => (r.first_logged as string) || "—" },
        { label: "Last logged",  field: r => (r.last_logged as string) || "—"  },
      ]}
    />
  );
}
