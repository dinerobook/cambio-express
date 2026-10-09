import { useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { MoneyInput } from "../../components/ui";
import { fmtMoney, fmtMoney2, fmtNumber } from "../../lib/formatters";
import { formatDateCompact } from "../../lib/datetime";

export default function HighValueTransfers() {
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
        <MoneyInput label="Threshold" value={threshold} onChange={commitThreshold} />
      </div>

      <ReportDrilldown
        apiSlug="high-value-transfers"
        title="High Value Transfers"
        resultUnit={["transfer", "transfers"]}
        backTo={baseRoute}
        csvUrl={`/api/v2/reports/high-value-transfers.csv`}
        extraParams={{ threshold: String(effective) }}
        kpis={[
          { label: `Above ${fmtMoney(effective)}`, tone: "primary",
            value: t => fmtNumber(Number(t.count ?? 0)) },
          { label: "Total Volume", tone: "neon",
            value: t => fmtMoney2(Number(t.amount ?? 0)) },
          { label: "Total Fees", tone: "muted",
            value: t => fmtMoney2(Number(t.fees ?? 0)) },
          { label: "Federal Tax", tone: "muted",
            value: t => fmtMoney2(Number(t.tax ?? 0)) },
        ]}
        columns={[
          { label: "Date",        field: r => formatDateCompact(r.send_date as string) },
          { label: "Sender",      field: "sender_name" },
          { label: "Recipient",   field: "recipient_name" },
          { label: "Country",     field: "country" },
          { label: "Company",     field: "company" },
          { label: "Send Amount", field: r => fmtMoney2(Number(r.amount)), align: "right", mono: true },
          { label: "Fee",         field: r => fmtMoney2(Number(r.fee)),    align: "right", mono: true },
          { label: "Federal Tax", field: r => fmtMoney2(Number(r.tax)),    align: "right", mono: true },
          { label: "Confirmation #",   field: "confirm", mono: true },
        ]}
      />
    </>
  );
}

