import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function NewVsReturning() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="new-vs-returning"
      title="New vs. returning senders"
      resultUnit={["bucket", "buckets"]}
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/new-vs-returning.csv`}
      kpis={[
        { label: "Total senders", tone: "primary",
          value: t => fmtNumber(Number(t.customers ?? 0)) },
        { label: "New",           tone: "neon",
          value: t => fmtNumber(Number(t.new_count ?? 0)) },
        { label: "Returning",     tone: "muted",
          value: t => fmtNumber(Number(t.returning_count ?? 0)) },
        { label: "Total sent",    tone: "muted",
          value: t => fmtMoney2(Number(t.sent ?? 0)) },
      ]}
      columns={[
        { label: "Bucket",     field: "bucket" },
        { label: "Customers",  field: r => fmtNumber(Number(r.customers)), align: "right", mono: true },
        { label: "Transfers",  field: r => fmtNumber(Number(r.txns)),      align: "right", mono: true },
        { label: "Total sent", field: r => fmtMoney2(Number(r.sent)),             align: "right", mono: true },
      ]}
    />
  );
}
