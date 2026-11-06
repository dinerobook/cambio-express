import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function ByDestinationCountry() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="by-destination-country"
      title="reportName.by_country"
      resultUnit="rep.unit.country"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/by-destination-country.csv`}
      kpis={[
        { label: "rep.totalSent",     tone: "primary", value: t => fmtMoney2(Number(t.sent ?? 0)) },
        { label: "rep.countryCount",  tone: "neon",
          value: () => "" /* rows.length is shown in the result-unit chip already */ },
        { label: "rep.transferCount", tone: "muted",   value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "rep.totalFees",     tone: "muted",   value: t => fmtMoney2(Number(t.fees ?? 0)) },
      ]}
      columns={[
        { label: "rep.country",     field: "country" },
        { label: "rep.count",       field: r => fmtNumber(Number(r.count)), align: "right", mono: true },
        { label: "rep.totalSent",  field: r => fmtMoney2(Number(r.sent)),         align: "right", mono: true },
        { label: "rep.fees",        field: r => fmtMoney2(Number(r.fees)),         align: "right", mono: true },
        { label: "rep.federalTax", field: r => fmtMoney2(Number(r.tax)),          align: "right", mono: true },
        { label: "rep.average",         field: r => fmtMoney2(Number(r.avg)),          align: "right", mono: true },
      ]}
    />
  );
}
