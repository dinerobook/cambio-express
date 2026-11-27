import type { DashboardPLMonth } from "../api/dashboard";
import { useT, tn } from "../i18n";
import { formatMonthYear } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { AppLink, KpiCard, Pill } from "./ui";
import styles from "./PLMonthTile.module.css";

/** The dashboard's Monthly P&L tile (owner, 2026-11-27): this
 *  month's live net profit with its income and expenses, how many
 *  days are in the books, the bank rows still to reconcile, and one
 *  click into the full P&L.
 *
 *  The server sends `pl_month` to store Admins only (Dashboard
 *  `_pl_month_block`); every other role gets null or no key, so the
 *  tile simply does not render. It is the kit `KpiCard`, wider: it
 *  spans two columns where the row has room. */
export function PLMonthTile({ pl }: { pl: DashboardPLMonth }) {
  const t = useT();
  const empty = pl.days_entered === 0
    && pl.total_income === 0 && pl.total_expenses === 0;
  const tone = pl.net_profit < 0 ? "negative" : "positive";
  return (
    <div className={styles.tile} data-testid="pl-month-tile">
      <KpiCard
        label={t("dash.plTile.label", {
          month: formatMonthYear(pl.year, pl.month),
        })}
        value={empty ? t("dash.plTile.nothingYet") : fmtMoney2(pl.net_profit)}
        colorValue={!empty}
        tone={empty ? "neutral" : tone}
        sub={
          <span className={styles.sub}>
            {!empty && (
              <span className={styles.figures}>
                <span>
                  {t("dash.plTile.income")}{" "}
                  <span className={styles.money}>{fmtMoney2(pl.total_income)}</span>
                </span>
                <span>
                  {t("dash.plTile.expenses")}{" "}
                  <span className={styles.money}>{fmtMoney2(pl.total_expenses)}</span>
                </span>
              </span>
            )}
            {!empty && (
              <span>{tn("dash.plTile.days", pl.days_entered, fmtNumber)}</span>
            )}
            <span className={styles.links}>
              {pl.to_reconcile != null && pl.to_reconcile > 0 && (
                <AppLink to="/bank-transactions" className={styles.todo}>
                  <Pill tone="warning">
                    {tn("dash.plTile.toReconcile", pl.to_reconcile, fmtNumber)}
                  </Pill>
                </AppLink>
              )}
              <AppLink to="/monthly" className={`ds-link ${styles.open}`}>
                {t("dash.plTile.open")}
              </AppLink>
            </span>
          </span>
        }
      />
    </div>
  );
}
