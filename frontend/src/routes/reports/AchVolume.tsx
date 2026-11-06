import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function AchVolume() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="ach-volume"
      title="reportName.ach_volume"
      resultUnit="rep.unit.company"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/ach-volume.csv`}
      kpis={[
        { label: "rep.totalAch",   tone: "primary",
          value: t => fmtMoney2(Number(t.amount ?? 0)) },
        { label: "rep.batchCount", tone: "neon",
          value: t => fmtNumber(Number(t.count ?? 0)) },
      ]}
      columns={[
        { label: "rep.company",     field: "company" },
        { label: "rep.batchCount", field: r => fmtNumber(Number(r.count)),  align: "right", mono: true },
        { label: "rep.totalAch",   field: r => fmtMoney2(Number(r.amount)),        align: "right", mono: true },
        { label: "rep.avgPerBatch", field: r => fmtMoney2(Number(r.avg)),           align: "right", mono: true },
      ]}
    />
  );
}
