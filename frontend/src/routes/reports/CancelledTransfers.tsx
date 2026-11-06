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
      title="reportName.cancelled_transfers"
      resultUnit="rep.unit.transfer"
      backTo={baseRoute}
      csvUrl={`/api/v2/reports/cancelled-transfers.csv`}
      kpis={[
        { label: "rep.total",        tone: "primary",
          value: t => fmtNumber(Number(t.count ?? 0)) },
        { label: "rep.cancelled",     tone: "muted",
          value: t => fmtNumber(Number(t.canceled ?? 0)) },
        { label: "rep.rejected",     tone: "muted",
          value: t => fmtNumber(Number(t.rejected ?? 0)) },
        { label: "rep.totalAmount", tone: "muted",
          value: t => fmtMoney2(Number(t.amount ?? 0)) },
      ]}
      columns={[
        { label: "rep.date",        field: r => formatDateCompact(r.send_date as string) },
        { label: "rep.sender",      field: "sender_name" },
        { label: "rep.recipient",   field: "recipient_name" },
        { label: "rep.country",     field: "country" },
        { label: "rep.company",     field: "company" },
        { label: "rep.status",      field: "status" },
        { label: "rep.sendAmount", field: r => fmtMoney2(Number(r.amount)), align: "right", mono: true },
        { label: "rep.notes",       field: "status_notes" },
        { label: "rep.confirmation",   field: "confirm", mono: true },
      ]}
    />
  );
}

