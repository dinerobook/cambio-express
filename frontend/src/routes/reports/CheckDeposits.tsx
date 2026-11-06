import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";
import { formatDateCompact } from "../../lib/datetime";

export default function CheckDeposits() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="check-deposits"
      title="reportName.check_deposits"
      resultUnit="rep.unit.day"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/check-deposits.csv`}
      kpis={[
        { label: "rep.totalAmount", tone: "primary",
          value: t => fmtMoney2(Number(t.amount ?? 0)) },
        { label: "rep.depositCount", tone: "neon",
          value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "rep.avgPerDay",    tone: "muted",
          value: t => fmtMoney2(Number(t.avg_per_day ?? 0)) },
      ]}
      columns={[
        { label: "rep.date",   field: r => formatDateCompact(r.date as string) },
        { label: "rep.count",  field: r => fmtNumber(Number(r.count)), align: "right", mono: true },
        { label: "rep.amount", field: r => fmtMoney2(Number(r.amount)),       align: "right", mono: true },
      ]}
    />
  );
}

