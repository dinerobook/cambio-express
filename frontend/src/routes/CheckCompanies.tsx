import {
  fetchCheckCompaniesPage, partyStatusLabel, useCheckCompanies,
  type CheckCompanyRow,
} from "../api/checkCashing";
import { PartyStatusPill } from "../components/CheckCashingFields";
import { CheckPartyList } from "../components/CheckPartyList";
import type { DataColumn } from "../components/ui";
import { navWord } from "../i18n/navWords";
import { tn, useT, type Translate } from "../i18n";
import { fmtNumber } from "../lib/formatters";
import styles from "./CheckCashing.module.css";

// Check cashing app → Companies (/app/check-cashing/companies).
// Whoever writes the checks (employers, agencies), found by the
// routing and account numbers printed on the check.

function columns(t: Translate): DataColumn<CheckCompanyRow>[] {
  return [
    {
      key: "name", header: t("checkCashing.companyName"), sortKey: "name",
      render: (r) => <span className={styles.name}>{r.name}</span>,
      csv: (r) => r.name,
    },
    {
      key: "routing", header: t("checkCashing.routing"),
      render: (r) => <span className={styles.mono}>{r.routing_number || "—"}</span>,
      csv: (r) => r.routing_number,
    },
    {
      key: "account", header: t("checkCashing.account"),
      render: (r) => (
        <span className={styles.mono}>{r.account_last4 ? `••••${r.account_last4}` : "—"}</span>
      ),
      csv: (r) => (r.account_last4 ? `••••${r.account_last4}` : ""),
    },
    {
      key: "status", header: t("checkCashing.status"), sortKey: "status",
      render: (r) => <PartyStatusPill status={r.status} />,
      csv: (r) => partyStatusLabel(r.status),
    },
    {
      key: "store", header: t("checkCashing.homeStore"),
      render: (r) => <span className={styles.muted}>{r.home_store_name || "—"}</span>,
      csv: (r) => r.home_store_name,
    },
  ];
}

export default function CheckCompanies() {
  const t = useT();
  return (
    <CheckPartyList<CheckCompanyRow>
      title={navWord("Companies")}
      subtitle={(total) => tn("checkCashing.companyCount", total, fmtNumber)}
      newTo="/check-cashing/companies/new"
      newLabel={t("checkCashing.newCompany")}
      searchPlaceholder={t("checkCashing.companySearchPlaceholder")}
      pageSizeKey="check-companies"
      columns={columns(t)}
      useRows={useCheckCompanies}
      fetchPage={fetchCheckCompaniesPage}
      rowKey={(r) => r.id}
      rowTo={(r) => `/check-cashing/companies/${r.id}`}
      rowLabel={(r) => t("checkCashing.openCompany", { name: r.name })}
      emptyTitle={t("checkCashing.noCompanies")}
      csvFilename="check-companies"
    />
  );
}
