import { useSearchParams } from "react-router-dom";

import {
  useOwnerPLRollup,
  type OwnerPLRollupRow,
} from "../api/owner";
import {
  Card, Empty, monoStyle, PageHeader,
  PageShell, PeriodStepper, Select, Table, TableStates, tdStyle, thStyle,
} from "../components/ui";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import styles from "./OwnerPLRollup.module.css";
import { formatMonthYear, monthName, shiftMonth, storeNow } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

// /app/owner/pl-rollup — side-by-side monthly P&L for every store
// in the owner umbrella. Mirrors the legacy /owner/pl-rollup view.

export default function OwnerPLRollup() {
  useT(); // re-render on a language switch
  const identity = getCurrentIdentity();
  const [sp, setSP] = useSearchParams();

  const today = storeNow();
  const year  = Number(sp.get("year")  ?? today.getFullYear());
  const month = Number(sp.get("month") ?? today.getMonth() + 1);

  const { data, isLoading, isError, error, refetch } = useOwnerPLRollup(year, month);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else       next.delete(key);
    setSP(next, { replace: true });
  }

  function shift(delta: number) {
    const to = shiftMonth(year, month, delta);
    const next = new URLSearchParams(sp);
    next.set("year", String(to.year));
    next.set("month", String(to.month));
    setSP(next, { replace: true });
  }

  const isOwner =
    identity?.role === "owner" || identity?.role === "superadmin";
  if (!isOwner) {
    return (
      <PageShell>
        <PageHeader title={navWord("P&L rollup")} />
        <Empty>{t("owner.signInRollup")}</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("P&L rollup")}
        subtitle={
          data
            ? tn("owner.rollupSubtitle", data.rows.length, fmtNumber, {
              month: formatMonthYear(data.year, data.month),
            })
            : "—"
        }
        actions={
          <PeriodStepper
            unit="month"
            onPrev={() => shift(-1)}
            onNext={() => shift(1)}
          >
            <Select
              aria-label={t("owner.month")}
              value={month}
              onChange={(e) => setParam("month", e.target.value)}
              style={{ width: "auto" }}
            >
              {MONTHS.map((m) => (
                <option key={m} value={m}>{monthName(m)}</option>
              ))}
            </Select>
            <Select
              aria-label={t("owner.year")}
              value={year}
              onChange={(e) => setParam("year", e.target.value)}
              style={{ width: "auto" }}
            >
              {(data?.year_choices ?? [year]).map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </Select>
          </PeriodStepper>
        }
      />

      <Card>
        <TableStates
          isLoading={isLoading} isError={isError} error={error}
          isEmpty={!data || data.rows.length === 0}
          onRetry={() => { void refetch(); }}
          emptyTitle={t("owner.noStoresConnectedShort")}
          emptyBody={t("owner.askRedeem")}
        />
        {data && data.rows.length > 0 && (
          <RollupTable rows={data.rows} totals={data.totals} />
        )}
      </Card>
    </PageShell>
  );
}

const ROLLUP_HEADERS: Array<[MessageKey, "left" | "right"]> = [
  ["owner.colStore", "left"],
  ["owner.colRevenue", "right"],
  ["owner.colPurchases", "right"],
  ["owner.colExpenses", "right"],
  ["owner.colOverShort", "right"],
  ["owner.colNet", "right"],
];

function RollupTable({
  rows, totals,
}: {
  rows: OwnerPLRollupRow[];
  totals: { revenue: number; purchases: number; expenses: number;
            over_short: number; net: number };
}) {
  return (
    <Table>
      <thead>
        <tr>
          {ROLLUP_HEADERS.map(([label, align]) => (
            <th key={label} style={{ ...thStyle, textAlign: align }}>
              {t(label)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.store_id}>
            <td style={tdStyle}>
              <div className={styles.storeName}>{r.store_name}</div>
              <div className={styles.storeSlug}>
                {r.store_slug}
                {!r.has_pl && (
                  <>
                    {" · "}
                    <span className={styles.noPL}>{t("owner.noPL")}</span>
                  </>
                )}
              </div>
            </td>
            <Money value={r.revenue} />
            <Money value={r.purchases} />
            <Money value={r.expenses} />
            <Money value={r.over_short} />
            <Money value={r.net} signed bold />
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td style={tdStyle} className={styles.totalsLabel}>{t("owner.totals")}</td>
          <Money value={totals.revenue}   bold />
          <Money value={totals.purchases} bold />
          <Money value={totals.expenses}  bold />
          <Money value={totals.over_short} bold />
          <Money value={totals.net}        signed bold />
        </tr>
      </tfoot>
    </Table>
  );
}

function Money({
  value, signed, bold,
}: {
  value: number;
  /** Tint negative red, positive green. Used for net. (Over/short is
   *  shown plain: on the P&L a positive value is a shortage.) */
  signed?: boolean;
  bold?: boolean;
}) {
  const colorClass = signed
    ? value < 0
      ? styles.moneyNeg
      : value > 0
        ? styles.moneyPos
        : styles.moneyZero
    : styles.moneyDefault;
  return (
    <td style={{ ...tdStyle, textAlign: "right" }}>
      <span
        className={`${colorClass} ${bold ? styles.bold : ""}`}
        style={monoStyle}
      >
        {signed && value > 0 ? "+" : ""}{fmtMoney2(value)}
      </span>
    </td>
  );
}
