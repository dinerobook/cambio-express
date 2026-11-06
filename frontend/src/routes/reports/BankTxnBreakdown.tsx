import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function BankTxnBreakdown() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="bank-transactions-breakdown"
      title="reportName.bank_txn_breakdown"
      resultUnit="rep.unit.category"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/bank-transactions-breakdown.csv`}
      kpis={[
        { label: "rep.inflows",          tone: "primary",
          value: t => fmtMoney2(Number(t.inflow ?? 0)) },
        { label: "rep.outflows",         tone: "neon",
          value: t => fmtMoney2(Number(t.outflow ?? 0)) },
        { label: "rep.net",              tone: "muted",
          value: t => fmtMoney2(Number(t.amount ?? 0)) },
        { label: "rep.transactionCount", tone: "muted",
          value: t => fmtNumber(Number(t.count ?? 0)) },
      ]}
      columns={[
        { label: "rep.category", field: "label" },
        { label: "rep.count",    field: r => fmtNumber(Number(r.count)), align: "right", mono: true },
        { label: "rep.signed",   field: r => fmtMoney2(Number(r.signed)),       align: "right", mono: true },
        { label: "rep.amount",   field: r => fmtMoney2(Number(r.amount)),       align: "right", mono: true },
      ]}
    />
  );
}
