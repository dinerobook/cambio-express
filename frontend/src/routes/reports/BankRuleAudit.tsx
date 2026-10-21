import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function BankRuleAudit() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="bank-rule-audit"
      title="Bank rule audit log"
      resultUnit={["rule", "rules"]}
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/bank-rule-audit.csv`}
      kpis={[
        { label: "Active rules",  tone: "primary",
          value: t => fmtNumber(Number(t.rules ?? 0)) },
        { label: "Auto-tagged",   tone: "neon",
          value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "Total amount",  tone: "muted",
          value: t => fmtMoney2(Number(t.amount ?? 0)) },
      ]}
      columns={[
        { label: "Rule",   field: "label" },
        { label: "Target", field: "target" },
        { label: "Match",  field: "match",                                  mono: true },
        { label: "Count",  field: r => fmtNumber(Number(r.count)),    align: "right", mono: true },
        { label: "Amount", field: r => fmtMoney2(Number(r.amount)),          align: "right", mono: true },
      ]}
    />
  );
}
