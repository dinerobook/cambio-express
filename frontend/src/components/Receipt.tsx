import type { ReactNode } from "react";

import {
  cashierLabel, eventDetailLabel, tenderLabel, ticketKindLabel,
  type PosTransactionDetail,
} from "../api/posimport";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { formatDayLabel, formatTime } from "../lib/datetime";
import { useT } from "../i18n";
import styles from "./Receipt.module.css";

type Line = PosTransactionDetail["lines"][number];

/** One register ticket drawn as the paper receipt the customer got —
 *  the ONE receipt renderer (the Transactions side panel and the
 *  ticket's own page both use it; UI-STANDARDS §7 "Register
 *  receipts").
 *
 *  Ink on white in either theme (the `--db-paper-*` tokens). What a
 *  back office adds to the till slip: every line's scan code and
 *  department, the regular price when the register sold below it,
 *  and the lines the cashier voided — struck through in red, with
 *  the price they rang at, never counted. A no-sale or a register
 *  open / close prints no items: the receipt says what happened. */
export function Receipt({
  tx, storeName,
}: {
  tx: PosTransactionDetail;
  storeName?: string;
}) {
  const t = useT();
  const at = tx.receipt_at ?? tx.started_at;
  const sold = tx.lines.filter((l) => l.status !== "cancel");
  const voided = tx.lines.filter((l) => l.status === "cancel");
  const isOther = tx.kind === "other" || tx.kind === "financial";
  const subtotal = tx.net - tx.tax;
  // Gross is the ticket at shelf prices; the sale after deals and
  // promotions is net − tax.
  const discount = Math.round((tx.gross - subtotal) * 100) / 100;
  const qty = (lines: Line[]) => lines.reduce(
    (sum, l) => sum + (l.is_fuel ? 1 : l.quantity), 0,
  );

  return (
    <article className={styles.receipt} aria-label={t("posTx.receiptLabel")}>
      <header className={styles.head}>
        {storeName && <div className={styles.store}>{storeName}</div>}
        {at && (
          <div className={styles.when}>
            {formatDayLabel(at)} · {formatTime(at)}
          </div>
        )}
        <dl className={styles.facts}>
          <Fact label={t("posTx.colTicket")} value={tx.transaction_no || `#${tx.id}`} mono />
          <Fact label={t("posTx.register")} value={tx.register_id || "—"} mono />
          <Fact
            label={t("posTx.colCashier")}
            value={cashierLabel(tx.cashier_id, tx.cashier_name)}
          />
        </dl>
        {tx.kind && tx.kind !== "sale" && !isOther && (
          <div className={styles.stamp}>{ticketKindLabel(tx.kind)}</div>
        )}
      </header>

      {isOther ? (
        <p className={styles.event}>
          {tx.detail_type ? eventDetailLabel(tx.detail_type) : ticketKindLabel(tx.kind)}
        </p>
      ) : (
        <>
          <ol className={styles.lines}>
            {tx.lines.map((line) => (
              <ReceiptLine key={`${line.line_seq}-${line.pos_code}-${line.status}`} line={line} />
            ))}
          </ol>

          <dl className={styles.totals}>
            <Total label={t("posTx.soldQty")} value={fmtNumber(qty(sold))} />
            {voided.length > 0 && (
              <Total label={t("posTx.voidedQty")} value={fmtNumber(qty(voided))} tone="void" />
            )}
            <Total label={t("posTx.subtotal")} value={fmtMoney2(subtotal)} />
            <Total label={t("posTx.colTax")} value={fmtMoney2(tx.tax)} />
            <Total label={t("posTx.colTotal")} value={fmtMoney2(tx.grand_total)} strong />
            {/* Already inside the line amounts (a 2-for-$6 deal rings
                $6.00): what the customer saved against shelf prices,
                the way a grocery slip says it — never taken off again. */}
            {discount > 0 && (
              <Total label={t("posTx.savings")} value={fmtMoney2(discount)} tone="muted" />
            )}
          </dl>

          {tx.tenders.length > 0 && (
            <dl className={styles.tenders}>
              {tx.tenders.map((tender, i) => (
                <Total
                  key={`${tender.code}-${i}`}
                  label={tender.is_change ? t("posTx.changeDue") : tenderLabel(tender.code)}
                  value={fmtMoney2(tender.amount)}
                  tone={tender.status === "cancel" ? "void" : undefined}
                />
              ))}
            </dl>
          )}
        </>
      )}
    </article>
  );
}

function ReceiptLine({ line }: { line: Line }) {
  const t = useT();
  const cancelled = line.status === "cancel";
  const qty = line.quantity || 1;
  // Passport's prices on an item line: RegularSellPrice is one
  // unit's shelf price, while ActualSalesPrice is the WHOLE line's
  // amount (2 tacos: regular $3.49, actual $6.98) — so the unit sold
  // at is amount ÷ qty. A voided line carries no amount: it shows
  // what it rang at, its regular price.
  const shown = cancelled ? line.regular_price * qty : line.amount;
  const unit = cancelled ? line.regular_price : Math.abs(line.amount) / qty;
  // Sold under the shelf price: an override, or a deal (2 for $6).
  const belowRegular = !cancelled && !line.is_fuel
    && line.regular_price > 0 && line.amount !== 0
    && unit < line.regular_price - 0.005;
  const dept = line.department_name
    || (line.merchandise_code ? t("posTx.deptNumber", { code: line.merchandise_code }) : "");
  const sub: ReactNode[] = [];
  if (line.is_fuel) {
    if (line.fuel_position) sub.push(t("posTx.pump", { pump: line.fuel_position }));
    if (line.gallons) {
      sub.push(t("posTx.galAt", {
        gallons: line.gallons.toFixed(3), price: fmtMoney2(line.actual_price),
      }));
    }
  } else {
    if (line.pos_code) sub.push(<span key="code" className={styles.mono}>{line.pos_code}</span>);
    // A department-key sale is already named after its department.
    if (dept && dept.toLowerCase() !== line.description.trim().toLowerCase()) sub.push(dept);
    if (belowRegular) {
      sub.push(
        <span key="reg" className={styles.flag}>
          {t("posTx.regularWas", { price: fmtMoney2(line.regular_price) })}
        </span>,
      );
    }
  }

  return (
    <li className={cancelled ? `${styles.line} ${styles.voided}` : styles.line}>
      <span className={styles.qty}>
        {line.is_fuel ? "" : fmtNumber(line.quantity)}
      </span>
      <span className={styles.desc}>
        {cancelled && <span className={styles.voidTag}>{t("posTx.voidTag")}</span>}
        <span className={styles.name}>
          {line.description || "—"}
          {!line.is_fuel && line.quantity !== 1 && unit > 0 && (
            <span className={styles.at}> {t("posTx.at", { price: fmtMoney2(unit) })}</span>
          )}
        </span>
        {sub.length > 0 && (
          <span className={styles.sub}>
            {sub.map((part, i) => (
              <span key={i}>{i > 0 && " · "}{part}</span>
            ))}
          </span>
        )}
      </span>
      <span className={styles.amount}>{shown ? fmtMoney2(shown) : "—"}</span>
    </li>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd className={mono ? styles.mono : undefined}>{value}</dd>
    </div>
  );
}

function Total({
  label, value, strong = false, tone,
}: { label: string; value: string; strong?: boolean; tone?: "void" | "muted" }) {
  const cls = [
    styles.total, strong ? styles.grand : "",
    tone === "void" ? styles.voidText : "", tone === "muted" ? styles.mutedText : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
