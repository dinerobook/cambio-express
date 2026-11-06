import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function BankRuleAudit() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="bank-rule-audit"
      title="reportName.bank_rule_audit"
      resultUnit="rep.unit.rule"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/bank-rule-audit.csv`}
      kpis={[
        { label: "rep.activeRules",  tone: "primary",
          value: t => fmtNumber(Number(t.rules ?? 0)) },
        { label: "rep.autoTagged",   tone: "neon",
          value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "rep.totalAmount",  tone: "muted",
          value: t => fmtMoney2(Number(t.amount ?? 0)) },
      ]}
      columns={[
        { label: "rep.rule",   field: "label" },
        { label: "rep.target", field: "target" },
        { label: "rep.match",  field: "match",                                  mono: true },
        { label: "rep.count",  field: r => fmtNumber(Number(r.count)),    align: "right", mono: true },
        { label: "rep.amount", field: r => fmtMoney2(Number(r.amount)),          align: "right", mono: true },
      ]}
    />
  );
}
