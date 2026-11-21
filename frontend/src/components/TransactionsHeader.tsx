import { useState } from "react";

import { Button, InfoTip, PageHeader, TabsBar, TabsLink } from "./ui";
import { CashierNamesModal } from "./CashierNamesModal";
import { PageCrumbs } from "./PageCrumbs";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

/** The top of both Transactions views: the trail, the title, the
 *  Cashier names button, and the Receipts | Items tabs. The tabs carry
 *  the range across, so switching views keeps the dates. */
export function TransactionsHeader({
  start, end, current,
}: {
  start: string;
  end: string;
  /** The trail's last step on the Items view. */
  current?: string;
}) {
  const t = useT();
  const [namesOpen, setNamesOpen] = useState(false);
  const range = new URLSearchParams({ start, end }).toString();
  return (
    <>
      <PageCrumbs current={current} />
      <PageHeader
        title={
          <>
            {navWord("Transactions")}
            <InfoTip text={t("posTx.tip")} />
          </>
        }
        subtitle={t("posTx.subtitle")}
        actions={
          <Button tone="secondary" perm="day_close.update" onClick={() => setNamesOpen(true)}>
            {t("posTx.cashierNames")}
          </Button>
        }
      />
      <TabsBar>
        <TabsLink to={`/transactions?${range}`} end>{t("posTx.viewReceipts")}</TabsLink>
        <TabsLink to={`/transactions/items?${range}`}>{t("posTx.viewItems")}</TabsLink>
      </TabsBar>
      <CashierNamesModal open={namesOpen} onClose={() => setNamesOpen(false)} />
    </>
  );
}
