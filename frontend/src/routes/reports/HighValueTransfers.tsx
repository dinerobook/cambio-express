import { useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { MoneyInput } from "../../components/ui";
import { fmtMoney, fmtMoney2, fmtNumber } from "../../lib/formatters";
import { formatDateCompact } from "../../lib/datetime";
import { useT } from "../../i18n";

export default function HighValueTransfers() {
  const translate = useT();
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  const [params, setParams] = useSearchParams();
  const [threshold, setThreshold] = useState(
    () => Number(params.get("threshold")) || 1000,
  );
  // An empty box means "use the default", not "every transfer".
  const effective = threshold || 1000;

  function commitThreshold(v: number) {
    setThreshold(v);
    const next = new URLSearchParams(params);
    next.set("threshold", String(v || 1000));
    setParams(next, { replace: true });
  }

  return (
    <>
      {/* Threshold control sits above the period filter on the
          underlying drilldown. */}
      <div style={{ maxWidth: "75rem", margin: "1rem auto 0", padding: "0 1.5rem" }}>
        <MoneyInput label={translate("rep.threshold")} value={threshold} onChange={commitThreshold} />
      </div>

      <ReportDrilldown
        apiSlug="high-value-transfers"
        title="reportName.high_value_transfers"
        resultUnit="rep.unit.transfer"
        backTo={baseRoute}
        csvUrl={`/api/v2/reports/high-value-transfers.csv`}
        extraParams={{ threshold: String(effective) }}
        kpis={[
          { label: "rep.above", labelVars: { amount: fmtMoney(effective) }, tone: "primary",
            value: t => fmtNumber(Number(t.count ?? 0)) },
          { label: "rep.totalVolume", tone: "neon",
            value: t => fmtMoney2(Number(t.amount ?? 0)) },
          { label: "rep.totalFees", tone: "muted",
            value: t => fmtMoney2(Number(t.fees ?? 0)) },
          { label: "rep.federalTax", tone: "muted",
            value: t => fmtMoney2(Number(t.tax ?? 0)) },
        ]}
        columns={[
          { label: "rep.date",        field: r => formatDateCompact(r.send_date as string) },
          { label: "rep.sender",      field: "sender_name" },
          { label: "rep.recipient",   field: "recipient_name" },
          { label: "rep.country",     field: "country" },
          { label: "rep.company",     field: "company" },
          { label: "rep.sendAmount", field: r => fmtMoney2(Number(r.amount)), align: "right", mono: true },
          { label: "rep.fee",         field: r => fmtMoney2(Number(r.fee)),    align: "right", mono: true },
          { label: "rep.federalTax", field: r => fmtMoney2(Number(r.tax)),    align: "right", mono: true },
          { label: "rep.confirmation",   field: "confirm", mono: true },
        ]}
      />
    </>
  );
}

