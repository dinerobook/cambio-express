import { useReportList } from "../api/reports";
import { ReportCenterPage } from "../components/ReportCenter";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// Two report centers, kept fully separate (owner directive — MSB
// and back-office must not blur): /reports renders the MSB
// collection, /store-reports the retail back-office collection.
// Same component, same server registry endpoint, different
// ?collection= filter.

export default function Reports({
  collection = "msb",
}: {
  collection?: "msb" | "store";
}) {
  const t = useT();
  return (
    <ReportCenterPage
      title={collection === "store" ? navWord("Store reports") : navWord("MSB reports")}
      list={useReportList(collection)}
      scopeMessage={t("reports.signInStore")}
      failedMessage={(error) => t("reports.listFailed", { error })}
    />
  );
}
