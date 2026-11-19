import DepartmentsManager from "../components/DepartmentsManager";
import { PageCrumbs } from "../components/PageCrumbs";
import { InfoTip, PageHeader, PageShell } from "../components/ui";
import { useT } from "../i18n";

// Account → Departments: the store's department setup, modelled on
// Modisoft's Setup → Departments (register number, type, tax, age
// limit, NACS code). The first thing a new retail store sets up — the
// register import and the daily paperwork both read it. The same
// manager is also the Price book's Departments tab.
export default function Departments() {
  const t = useT();
  return (
    <PageShell>
      <PageCrumbs />
      <PageHeader
        title={
          <>
            {t("dept.title")}
            <InfoTip text={t("dept.tip")} />
          </>
        }
        subtitle={t("dept.pageSubtitle")}
      />
      <DepartmentsManager showTitle={false} />
    </PageShell>
  );
}
