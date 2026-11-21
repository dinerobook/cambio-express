import type { ReactNode } from "react";

import { type PosTransactionDetail, useTransaction } from "../api/posimport";
import {
  Alert, AppLink, ErrorState, IconButton, Loading,
} from "./ui";
import { Receipt } from "./Receipt";
import { tNodes, useT } from "../i18n";
import styles from "./ReceiptPanel.module.css";

/** A list with the open ticket's receipt beside it (which ticket:
 *  `useOpenReceipt`, lib/useOpenReceipt.ts). */
export function ReceiptSplit({
  selected, storeName, onClose, children,
}: {
  selected: number | null;
  storeName?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className={selected ? `${styles.split} ${styles.withPanel}` : styles.split}>
      <div className={styles.list}>{children}</div>
      {selected && (
        <aside className={styles.aside} aria-label={t("posTx.receiptLabel")}>
          <ReceiptPanel id={selected} storeName={storeName} onClose={onClose} />
        </aside>
      )}
    </div>
  );
}

/** The chosen ticket's receipt, with the notes a manager needs to read
 *  it right and the way to its own page. */
export function ReceiptPanel({
  id, storeName, onClose,
}: {
  id: number;
  storeName?: string;
  onClose: () => void;
}) {
  const t = useT();
  const query = useTransaction(id);
  const tx = query.data?.transaction;

  return (
    <div className={styles.panel}>
      <div className={styles.bar}>
        <AppLink to={`/transactions/${id}`} className="ds-link">
          {t("posTx.openFullPage")}
        </AppLink>
        <IconButton
          tone="ghost" size="sm" onClick={onClose}
          title={t("posTx.closeReceipt")} aria-label={t("posTx.closeReceipt")}
        >
          ×
        </IconButton>
      </div>
      {query.isLoading && <Loading />}
      {query.isError && (
        <ErrorState
          message={t("posTx.detailLoadFailed")}
          onRetry={() => { void query.refetch(); }}
        />
      )}
      {tx && (
        <>
          <TicketNotes tx={tx} />
          <Receipt tx={tx} storeName={storeName} />
        </>
      )}
    </div>
  );
}

/** What a receipt alone cannot say: the fuel prepay a ticket belongs
 *  to, and that a voided item is shown but never counted. Shared by
 *  the side panel and the ticket's own page. */
export function TicketNotes({ tx }: { tx: PosTransactionDetail }) {
  const t = useT();
  const voided = tx.lines.filter((l) => l.status === "cancel").length;
  return (
    <>
      {tx.superseded && (
        <Alert tone="info">
          {t("posTx.supersededNote")}
          {tx.superseded_by_id !== null && (
            <>
              {" "}
              <AppLink to={`/transactions/${tx.superseded_by_id}`} className="ds-link">
                {t("posTx.openCompletion")}
              </AppLink>
            </>
          )}
        </Alert>
      )}
      {/* Only a completion that counts says so: a superseded one is
          covered above, and a void completion never counts. */}
      {tx.linked_reason === "fuelPrepay" && !tx.superseded
        && (tx.kind === "sale" || tx.kind === "refund") && (
        <Alert tone="info">
          {tNodes("posTx.completesPrepay", {
            ticket: tx.linked_id !== null ? (
              <AppLink to={`/transactions/${tx.linked_id}`} className="ds-link" fallback="text">
                {tx.linked_transaction_no || `#${tx.linked_id}`}
              </AppLink>
            ) : (tx.linked_transaction_no || "—"),
          })}
        </Alert>
      )}
      {voided > 0 && (
        <Alert tone="warning">
          {voided === 1
            ? t("posTx.voidedOne")
            : t("posTx.voidedMany", { count: voided })}
        </Alert>
      )}
      {tx.kind === "void" && (
        <Alert tone="warning">{t("posTx.voidTicketNote")}</Alert>
      )}
    </>
  );
}
