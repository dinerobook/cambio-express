import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function FeesVsTax() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="fees-vs-tax"
      title="reportName.fees_vs_tax"
      resultUnit="rep.unit.line"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/fees-vs-tax.csv`}
      kpis={[
        { label: "rep.totalFees",     tone: "neon",
          value: t => fmtMoney2(Number(t.fees ?? 0)) },
        { label: "rep.federalTax",    tone: "muted",
          value: t => fmtMoney2(Number(t.tax ?? 0)) },
        { label: "rep.taxFeeRatio", tone: "muted",
          value: t => `${(Number(t.ratio ?? 0) * 100).toFixed(1)}%` },
        { label: "rep.transferCount", tone: "muted",
          value: t => fmtNumber(Number(t.count ?? 0)) },
      ]}
      columns={[
        { label: "rep.line",   field: "label" },
        { label: "rep.amount", field: r => fmtMoney2(Number(r.amount)), align: "right", mono: true },
        { label: "rep.note",   field: r => (r.note as string) || "" },
      ]}
    />
  );
}
