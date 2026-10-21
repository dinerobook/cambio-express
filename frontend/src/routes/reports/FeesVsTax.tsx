import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function FeesVsTax() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="fees-vs-tax"
      title="Fees vs. federal tax"
      resultUnit={["line", "lines"]}
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/fees-vs-tax.csv`}
      kpis={[
        { label: "Total fees",     tone: "neon",
          value: t => fmtMoney2(Number(t.fees ?? 0)) },
        { label: "Federal tax",    tone: "muted",
          value: t => fmtMoney2(Number(t.tax ?? 0)) },
        { label: "Tax / fee ratio", tone: "muted",
          value: t => `${(Number(t.ratio ?? 0) * 100).toFixed(1)}%` },
        { label: "Transfer count", tone: "muted",
          value: t => fmtNumber(Number(t.count ?? 0)) },
      ]}
      columns={[
        { label: "Line",   field: "label" },
        { label: "Amount", field: r => fmtMoney2(Number(r.amount)), align: "right", mono: true },
        { label: "Note",   field: r => (r.note as string) || "" },
      ]}
    />
  );
}
