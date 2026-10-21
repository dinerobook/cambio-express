import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function TopRecipients() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="top-recipients"
      title="Top recipients"
      resultUnit={["recipient", "recipients"]}
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/top-recipients.csv`}
      kpis={[
        { label: "Total sent",      tone: "primary", value: t => fmtMoney2(Number(t.sent ?? 0)) },
        { label: "Transfer count",  tone: "neon",    value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "Total fees",      tone: "muted",   value: t => fmtMoney2(Number(t.fees ?? 0)) },
      ]}
      columns={[
        { label: "Recipient",   field: "recipient" },
        { label: "Count",       field: r => fmtNumber(r.count), align: "right", mono: true },
        { label: "Total sent",  field: r => fmtMoney2(Number(r.sent)), align: "right", mono: true },
        { label: "Fees",        field: r => fmtMoney2(Number(r.fees)), align: "right", mono: true },
        { label: "Federal tax", field: r => fmtMoney2(Number(r.tax)),  align: "right", mono: true },
        { label: "Average",         field: r => fmtMoney2(Number(r.avg)),  align: "right", mono: true },
      ]}
    />
  );
}
