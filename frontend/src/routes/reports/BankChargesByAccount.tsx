import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";

export default function BankChargesByAccount() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="bank-charges-by-account"
      title="reportName.bank_charges"
      resultUnit="rep.unit.account"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/bank-charges-by-account.csv`}
      kpis={[
        { label: "rep.totalCharges", tone: "primary",
          value: t => fmtMoney2(Number(t.amount ?? 0)) },
        { label: "rep.chargeCount",  tone: "neon",
          value: t => fmtNumber(Number(t.count ?? 0)) },
      ]}
      columns={[
        { label: "rep.account", field: r =>
          `${r.account}${r.last4 ? ` ••${r.last4}` : ""}` },
        { label: "rep.count",   field: r => fmtNumber(Number(r.count)), align: "right", mono: true },
        { label: "rep.amount",  field: r => fmtMoney2(Number(r.amount)),       align: "right", mono: true },
        { label: "rep.average",     field: r => fmtMoney2(Number(r.avg)),          align: "right", mono: true },
      ]}
    />
  );
}
