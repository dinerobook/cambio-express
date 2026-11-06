import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function ReturnedCheckStatus() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="returned-check-status"
      title="reportName.returned_checks_status"
      resultUnit="rep.unit.status"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/returned-check-status.csv`}
      kpis={[
        { label: "rep.totalBounces", tone: "primary",
          value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "rep.totalAmount",  tone: "neon",
          value: t => fmtMoney2(Number(t.amount ?? 0)) },
        { label: "rep.recovered",     tone: "muted",
          value: t => fmtMoney2(Number(t.recovered ?? 0)) },
        { label: "rep.netGainLoss",       tone: "muted",
          value: t => fmtMoney2(Number(t.net_gl ?? 0)) },
      ]}
      columns={[
        { label: "rep.status",    field: "status" },
        { label: "rep.count",     field: r => fmtNumber(Number(r.count)),     align: "right", mono: true },
        { label: "rep.amount",    field: r => fmtMoney2(Number(r.amount)),           align: "right", mono: true },
        { label: "rep.recovered", field: r => fmtMoney2(Number(r.recovered)),        align: "right", mono: true },
      ]}
    />
  );
}
