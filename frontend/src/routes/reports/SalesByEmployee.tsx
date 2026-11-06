import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function SalesByEmployee() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="sales-by-employee"
      title="reportName.sales_by_employee"
      resultUnit="rep.unit.employee"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/sales-by-employee.csv`}
      kpis={[
        { label: "rep.totalSent",     tone: "primary", value: t => fmtMoney2(Number(t.sent ?? 0)) },
        { label: "rep.totalFees",     tone: "neon",    value: t => fmtMoney2(Number(t.fees ?? 0)) },
        { label: "rep.totalFederalTax",  tone: "muted",   value: t => fmtMoney2(Number(t.tax ?? 0)) },
        { label: "rep.transferCount", tone: "muted",   value: t => fmtNumber(Number(t.count ?? 0)) },
      ]}
      columns={[
        { label: "rep.employee",    field: "employee" },
        { label: "rep.count",       field: r => fmtNumber(r.count), align: "right", mono: true },
        { label: "rep.totalSent",  field: r => fmtMoney2(Number(r.sent)), align: "right", mono: true },
        { label: "rep.fees",        field: r => fmtMoney2(Number(r.fees)), align: "right", mono: true },
        { label: "rep.federalTax", field: r => fmtMoney2(Number(r.tax)),  align: "right", mono: true },
        { label: "rep.average",         field: r => fmtMoney2(Number(r.avg)),  align: "right", mono: true },
      ]}
    />
  );
}
