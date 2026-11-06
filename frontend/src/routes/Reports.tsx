import { useReportList } from "../api/reports";
import ReportCenter from "../components/ReportCenter";
import { ErrorState, Loading, PageHeader, PageShell } from "../components/ui";
import { ApiError, apiErrorMessage } from "../lib/api";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, useT } from "../i18n";
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
  useT(); // re-render on a language switch
  const title = collection === "store"
    ? navWord("Store reports")
    : navWord("MSB reports");
  const { data, isLoading, isError, error, refetch } =
    useReportList(collection);

  if (isLoading) {
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title={title} />
        <Loading />
      </PageShell>
    );
  }
  if (isError || !data) {
    const status = error instanceof ApiError ? error.status : 0;
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title={title} />
        <ErrorState
          message={
            status === 403
              ? t("reports.signInStore")
              : t("reports.listFailed", { error: apiErrorMessage(error, "") }).trim()
          }
          onRetry={status === 403 ? undefined : () => { void refetch(); }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageCrumbs />
      <ReportCenter title={title} categories={data.categories} />
    </PageShell>
  );
}
