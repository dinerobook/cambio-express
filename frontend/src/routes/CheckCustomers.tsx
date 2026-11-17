import {
  fetchCheckCustomersPage, partyStatusLabel, useCheckCustomers,
  type CheckCustomerRow,
} from "../api/checkCashing";
import { PartyStatusPill } from "../components/CheckCashingFields";
import { CheckPartyList } from "../components/CheckPartyList";
import { Pill, type DataColumn } from "../components/ui";
import { navWord } from "../i18n/navWords";
import { tn, useT, type Translate } from "../i18n";
import { fmtNumber } from "../lib/formatters";
import styles from "./CheckCashing.module.css";

// Check cashing app → Customers (/app/check-cashing/customers).
// Everyone who cashes checks here or at a store sharing this store's
// owner. Live search by name, phone or ID number.

function columns(t: Translate): DataColumn<CheckCustomerRow>[] {
  return [
    {
      key: "name", header: t("checkCashing.name"), sortKey: "name",
      render: (r) => <span className={styles.name}>{r.full_name}</span>,
      csv: (r) => r.full_name,
    },
    {
      key: "phone", header: t("checkCashing.phone"),
      render: (r) => (
        <span className={styles.mono}>
          {r.phone_number ? `${r.phone_country} ${r.phone_number}` : "—"}
        </span>
      ),
      csv: (r) => (r.phone_number ? `${r.phone_country} ${r.phone_number}` : ""),
    },
    {
      key: "id", header: t("checkCashing.idOnFile"),
      render: (r) => (
        <span className={styles.statusCell}>
          <span className={styles.mono}>{r.id_summary || "—"}</span>
          {r.has_expired_id && <Pill tone="warning">{t("checkCashing.idExpired")}</Pill>}
        </span>
      ),
      csv: (r) => r.id_summary,
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

export default function CheckCustomers() {
  const t = useT();
  return (
    <CheckPartyList<CheckCustomerRow>
      title={navWord("Customers")}
      subtitle={(total) => tn("checkCashing.customerCount", total, fmtNumber)}
      newTo="/check-cashing/customers/new"
      newLabel={t("checkCashing.newCustomer")}
      searchPlaceholder={t("checkCashing.customerSearchPlaceholder")}
      pageSizeKey="check-customers"
      columns={columns(t)}
      useRows={useCheckCustomers}
      fetchPage={fetchCheckCustomersPage}
      rowKey={(r) => r.id}
      rowTo={(r) => `/check-cashing/customers/${r.id}`}
      rowLabel={(r) => t("checkCashing.openCustomer", { name: r.full_name })}
      emptyTitle={t("checkCashing.noCustomers")}
      csvFilename="check-customers"
    />
  );
}
