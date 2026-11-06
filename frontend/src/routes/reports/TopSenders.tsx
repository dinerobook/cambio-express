import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";
import { maskPhone } from "../../lib/format";

export default function TopSenders() {
  // Same shape as Top Customers but sorted by transfer count rather
  // than total sent. Shares the API endpoint with sort_by=count.
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="top-customers"
      title="reportName.top_senders"
      resultUnit="rep.unit.sender"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/top-senders.csv`}
      extraParams={{ sort_by: "count" }}
      kpis={[
        { label: "rep.totalSent",     tone: "primary", value: t => fmtMoney2(Number(t.sent ?? 0)) },
        { label: "rep.transferCount", tone: "neon",    value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "rep.totalFees",     tone: "muted",   value: t => fmtMoney2(Number(t.fees ?? 0)) },
      ]}
      columns={[
        { label: "rep.customer",    field: "customer" },
        { label: "rep.phone",       field: r => maskPhone(String(r.phone ?? "")), mono: true },
        { label: "rep.count",       field: r => fmtNumber(r.count), align: "right", mono: true },
        { label: "rep.totalSent",  field: r => fmtMoney2(Number(r.sent)), align: "right", mono: true },
        { label: "rep.fees",        field: r => fmtMoney2(Number(r.fees)), align: "right", mono: true },
        { label: "rep.federalTax", field: r => fmtMoney2(Number(r.tax)),  align: "right", mono: true },
        { label: "rep.average",         field: r => fmtMoney2(Number(r.avg)),  align: "right", mono: true },
      ]}
    />
  );
}
