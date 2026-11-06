import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2 } from "../../lib/formatters";

export default function PeriodPL() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="period-pl"
      title="reportName.period_pl"
      resultUnit="rep.unit.line"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/period-pl.csv`}
      kpis={[
        { label: "rep.revenue",   tone: "primary",
          value: t => fmtMoney2(Number(t.revenue ?? 0)) },
        { label: "rep.expenses",  tone: "muted",
          value: t => fmtMoney2(Number(t.expenses ?? 0)) },
        { label: "rep.netIncome", tone: "neon",
          value: t => fmtMoney2(Number(t.net_income ?? 0)) },
      ]}
      columns={[
        { label: "rep.line",   field: "label" },
        { label: "rep.amount", field: r => fmtMoney2(Number(r.amount ?? 0)), align: "right", mono: true },
        { label: "rep.note",   field: r => (r.note as string) || "" },
      ]}
    />
  );
}
