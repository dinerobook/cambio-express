import { useEffect } from "react";
import { useParams } from "react-router-dom";

import { useTransferReceipt } from "../api/transfers";
import { apiErrorMessage } from "../lib/api";
import { fmtMoney2 } from "../lib/formatters";
import { AppLink, Button, ErrorState, Loading } from "../components/ui";
import styles from "./TransferReceipt.module.css";
import {
  isDebitCard, isPayout, serviceLabel, statusLabel, transferWording,
} from "../lib/transferKinds";
import { useT } from "../i18n";

// /app/transfers/{id}/receipt — printable transfer receipt.
//
// Layout:
//   ┌────────────────────────────────────────────────────────┐
//   │  [Logo]   Store name                  Tax ID           │
//   │           Address · Phone · Email                      │
//   ├────────────────────────────────────────────────────────┤
//   │  TRANSFER RECEIPT      Date · Confirm # · Status       │
//   ├────────────────────────────────────────────────────────┤
//   │  Sender:    Maria Lopez                                │
//   │             +1 5551112222                              │
//   │             123 Main St, Houston TX                    │
//   │                                                        │
//   │  Recipient: Juan Garcia                                │
//   │             +52 ... · Mexico                           │
//   ├────────────────────────────────────────────────────────┤
//   │  Service     Company       Amount    Fee   Tax  TOTAL  │
//   │  Money tx    Intermex      100.00   5.00  1.00 106.00 │
//   ├────────────────────────────────────────────────────────┤
//   │  Cashier signature:        Customer signature:         │
//   │  ____________________      ____________________        │
//   ├────────────────────────────────────────────────────────┤
//   │  {store.receipt_footer or default system footer}       │
//   └────────────────────────────────────────────────────────┘
//
// Print CSS hides everything except the receipt card so the
// operator's browser print dialog produces a clean page.

export default function TransferReceipt() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const transferId = Number(id);
  const { data, isLoading, isError, error, refetch } =
    useTransferReceipt(transferId);

  // Set the document title so the browser's print preview filename
  // defaults to something readable. Reset on unmount.
  useEffect(() => {
    if (!data) return;
    const original = document.title;
    document.title = t("transfer.receiptDocTitle", {
      ref: data.transfer.confirm_number || `#${data.transfer.id}`,
      store: data.store.name,
    });
    return () => { document.title = original; };
  }, [data, t]);

  if (!Number.isFinite(transferId)) {
    return (
      <div className={styles.page}>
        <div className={styles.shellChrome}>
          <AppLink to="/transfers" className={styles.backLink}>
            {t("transfer.backToList")}
          </AppLink>
        </div>
        <ErrorState message={t("transfer.invalidId")} />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.shellChrome}>
          <AppLink to="/transfers" className={styles.backLink}>
            {t("transfer.backToList")}
          </AppLink>
        </div>
        <Loading />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className={styles.page}>
        <div className={styles.shellChrome}>
          <AppLink to="/transfers" className={styles.backLink}>
            {t("transfer.backToList")}
          </AppLink>
        </div>
        <ErrorState
          message={
            `${t("transfer.receiptLoadFailed")} ${apiErrorMessage(error, "")}`.trimEnd()
          }
          onRetry={() => { void refetch(); }}
        />
      </div>
    );
  }

  const { store, transfer } = data;
  const total = fmtMoney2(transfer.total_collected);
  const payout = isPayout(transfer.service_type);
  const words = transferWording(transfer.service_type);

  return (
    <div className={styles.page}>
      {/* Chrome — hidden in print so only the receipt card prints. */}
      <div className={styles.shellChrome}>
        <AppLink to={`/transfers/${transfer.id}/edit`} className={styles.backLink}>
          {t("transfer.backToTransfer")}
        </AppLink>
        <Button
          tone="primary"
          size="sm"
          onClick={() => window.print()}
        >
          {t("transfer.printReceipt")}
        </Button>
      </div>

      <article className={styles.receipt} aria-label={t("transfer.receipt")}>
        <header className={styles.header}>
          {store.receipt_logo_url ? (
            <img
              src={store.receipt_logo_url}
              alt={store.name}
              className={styles.logo}
            />
          ) : (
            <div className={styles.wordmark}>{store.name}</div>
          )}
          <div className={styles.headerMeta}>
            {store.receipt_logo_url && (
              <div className={styles.storeName}>{store.name}</div>
            )}
            {store.address && (
              <div className={styles.storeLine}>{store.address}</div>
            )}
            <div className={styles.storeLine}>
              {[store.phone, store.email].filter(Boolean).join(" · ")}
            </div>
            {store.receipt_tax_id && (
              <div className={styles.storeLine}>
                {t("transfer.taxId", { id: store.receipt_tax_id })}
              </div>
            )}
          </div>
        </header>

        <div className={styles.titleBar}>
          <span className={styles.title}>{t("transfer.receipt")}</span>
          <span className={styles.meta}>
            {transfer.send_date}
            {transfer.confirm_number && (
              <> · {t("transfer.confirmationRef", { number: transfer.confirm_number })}</>
            )}
            <> · {statusLabel(transfer.status)}</>
          </span>
        </div>

        <section className={styles.parties}>
          <div>
            <h2 className={styles.partyHeading}>{words.customer}</h2>
            <div className={styles.partyName}>{transfer.sender_name || "—"}</div>
            {transfer.sender_phone && (
              <div className={styles.partyLine}>
                {transfer.sender_phone_country} {transfer.sender_phone}
              </div>
            )}
            {transfer.sender_address && (
              <div className={styles.partyLine}>
                {transfer.sender_address}
              </div>
            )}
          </div>
          <div>
            <h2 className={styles.partyHeading}>{words.other}</h2>
            <div className={styles.partyName}>{transfer.recipient_name || "—"}</div>
            {transfer.recipient_phone && (
              <div className={styles.partyLine}>{transfer.recipient_phone}</div>
            )}
            <div className={styles.partyLine}>{transfer.country}</div>
          </div>
        </section>

        <div style={{ overflowX: "auto" }}>
        <table className={styles.amounts}>
          <thead>
            <tr>
              <th>{t("transfer.service")}</th>
              <th>{t("transfer.company")}</th>
              <th className={styles.numCol}>{words.amount}</th>
              <th className={styles.numCol}>{t("transfer.fee")}</th>
              <th className={styles.numCol}>{t("transfer.federalTax")}</th>
              <th className={styles.numCol}>{t("transfer.total")}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{serviceLabel(transfer.service_type)}</td>
              <td>{transfer.company}</td>
              <td className={styles.numCol}>
                {fmtMoney2(transfer.send_amount)}
              </td>
              <td className={styles.numCol}>
                {fmtMoney2(transfer.fee)}
              </td>
              <td className={styles.numCol}>
                {fmtMoney2(transfer.federal_tax)}
              </td>
              <td className={`${styles.numCol} ${styles.totalCell}`}>
                {total}
              </td>
            </tr>
          </tbody>
        </table>
        </div>

        <div className={styles.totalBlock}>
          <span className={styles.totalLabel}>
            {payout
              ? t("transfer.paidToCustomerCash")
              : isDebitCard(transfer.payment_method)
                ? t("transfer.customerPaidCard")
                : t("transfer.customerPaid")}
          </span>
          <span className={styles.totalAmount}>{total}</span>
        </div>

        <section className={styles.signatures}>
          <div className={styles.signatureRow}>
            <span className={styles.signatureLine} />
            <span className={styles.signatureLabel}>
              {transfer.employee_name
                ? t("transfer.cashierNamed", { name: transfer.employee_name })
                : t("transfer.cashier")}
            </span>
          </div>
          <div className={styles.signatureRow}>
            <span className={styles.signatureLine} />
            <span className={styles.signatureLabel}>
              {t("transfer.customer")}
            </span>
          </div>
        </section>

        <footer className={styles.footer}>
          {store.receipt_footer
            || (payout ? t("transfer.footerPayout") : t("transfer.footerSend"))}
          <div className={styles.footerMeta}>
            {t("transfer.poweredBy")}
          </div>
        </footer>
      </article>
    </div>
  );
}
