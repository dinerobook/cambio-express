import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function NewVsReturning() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="new-vs-returning"
      title="reportName.new_vs_returning"
      resultUnit="rep.unit.bucket"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/new-vs-returning.csv`}
      kpis={[
        { label: "rep.totalSenders", tone: "primary",
          value: t => fmtNumber(Number(t.customers ?? 0)) },
        { label: "rep.new",           tone: "neon",
          value: t => fmtNumber(Number(t.new_count ?? 0)) },
        { label: "rep.returning",     tone: "muted",
          value: t => fmtNumber(Number(t.returning_count ?? 0)) },
        { label: "rep.totalSent",    tone: "muted",
          value: t => fmtMoney2(Number(t.sent ?? 0)) },
      ]}
      columns={[
        { label: "rep.bucket",     field: "bucket" },
        { label: "rep.customers",  field: r => fmtNumber(Number(r.customers)), align: "right", mono: true },
        { label: "rep.transfers",  field: r => fmtNumber(Number(r.txns)),      align: "right", mono: true },
        { label: "rep.totalSent", field: r => fmtMoney2(Number(r.sent)),             align: "right", mono: true },
      ]}
    />
  );
}
