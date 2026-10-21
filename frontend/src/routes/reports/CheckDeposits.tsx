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
      title="Check deposits"
      resultUnit={["day", "days"]}
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/check-deposits.csv`}
      kpis={[
        { label: "Total amount", tone: "primary",
          value: t => fmtMoney2(Number(t.amount ?? 0)) },
        { label: "Deposit count", tone: "neon",
          value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "Average per day",    tone: "muted",
          value: t => fmtMoney2(Number(t.avg_per_day ?? 0)) },
      ]}
      columns={[
        { label: "Date",   field: r => formatDateCompact(r.date as string) },
        { label: "Count",  field: r => fmtNumber(Number(r.count)), align: "right", mono: true },
        { label: "Amount", field: r => fmtMoney2(Number(r.amount)),       align: "right", mono: true },
      ]}
    />
  );
}

