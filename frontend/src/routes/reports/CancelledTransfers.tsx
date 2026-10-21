import { useLocation } from "react-router-dom";

import { ReportDrilldown } from "../../components/ReportDrilldown";
import { fmtMoney2, fmtNumber } from "../../lib/formatters";
import { formatDateCompact } from "../../lib/datetime";

export default function CancelledTransfers() {
  const isOwner = useLocation().pathname.startsWith("/owner/");
  const baseRoute = isOwner ? "/owner/reports" : "/reports";
  return (
    <ReportDrilldown
      apiSlug="cancelled-transfers"
      title="Cancelled transfers"
      resultUnit={["transfer", "transfers"]}
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/cancelled-transfers.csv`}
      kpis={[
        { label: "Total",        tone: "primary",
          value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "Cancelled",     tone: "muted",
          value: t => fmtNumber(Number(t.canceled ?? 0)) },
        { label: "Rejected",     tone: "muted",
          value: t => fmtNumber(Number(t.rejected ?? 0)) },
        { label: "Total amount", tone: "muted",
          value: t => fmtMoney2(Number(t.amount ?? 0)) },
      ]}
      columns={[
        { label: "Date",        field: r => formatDateCompact(r.send_date as string) },
        { label: "Sender",      field: "sender_name" },
        { label: "Recipient",   field: "recipient_name" },
        { label: "Country",     field: "country" },
        { label: "Company",     field: "company" },
        { label: "Status",      field: "status" },
        { label: "Send amount", field: r => fmtMoney2(Number(r.amount)), align: "right", mono: true },
        { label: "Notes",       field: "status_notes" },
        { label: "Confirmation #",   field: "confirm", mono: true },
      ]}
    />
  );
}

