import type { ReactNode } from "react";

import { ButtonLink, PageHeader, TabsBar, TabsLink } from "./ui";
import { PageCrumbs } from "./PageCrumbs";
import { useT } from "../i18n";
import styles from "./ReturnChecksHeader.module.css";

/** The top of every Returned checks view: one title (the sidebar's
 *  "Returned checks"), the two ways to add (one check, or a batch the
 *  bank sent back together), and the four views — Checks, Batches,
 *  By company, By customer. Each tab is its own URL so a filtered
 *  view can be shared and Back returns to it. */
export function ReturnChecksHeader({ subtitle }: { subtitle?: ReactNode }) {
  const t = useT();
  return (
    <>
      <PageCrumbs />
      <PageHeader
        title={t("returnCheck.listTitle")}
        subtitle={subtitle}
        actions={(
          <div className={styles.actions}>
            <ButtonLink to="/return-checks/batches/new" tone="secondary" size="sm">
              {t("returnCheck.newBatchButton")}
            </ButtonLink>
            <ButtonLink to="/return-checks/new" tone="primary" size="sm">
              {t("returnCheck.newButton")}
            </ButtonLink>
          </div>
        )}
      />
      <TabsBar>
        <TabsLink to="/return-checks" end>{t("returnCheck.tabChecks")}</TabsLink>
        <TabsLink to="/return-checks/batches" end>{t("returnCheck.tabBatches")}</TabsLink>
        <TabsLink to="/return-checks/companies">{t("returnCheck.tabCompanies")}</TabsLink>
        <TabsLink to="/return-checks/customers">{t("returnCheck.tabCustomers")}</TabsLink>
      </TabsBar>
    </>
  );
}
