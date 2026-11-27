import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import {
  MONTHLY_LINES, MONTHLY_SECTION_LABELS, MONTHLY_SOURCE_LABELS,
  monthlyLineName, monthlyLineSource,
  useLoggedMonths, useMonthly, useMonthlyRange, type MonthlyCustomLine,
  type MonthlyLeftOut, type MonthlyLine, type MonthlyRow,
} from "../api/monthly";
import { Delta } from "../components/Delta";
import { PLTransactions } from "../components/PLTransactions";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { hasPermission } from "../lib/permissions";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  Alert, AppLink, ButtonLink, Card, DateRangePicker, Empty, EmptyState,
  ErrorState, Loading, PageHeader, KpiCard, KpiGrid, PageShell, PeriodStepper,
  Pill, Section, Table,
  TabsBar, TabsButton,
  tdStyle, tdStyleRight, thStyle, thStyleRight,
  type PillTone,
} from "../components/ui";
import styles from "./Monthly.module.css";
import { monthName, shiftMonth, storeNow } from "../lib/datetime";
import {
  monthRange, rangeLabel, wholeMonth, type IsoRange,
} from "../lib/dateRanges";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// Monthly P&L at /app/monthly?year=Y&month=M, or any days at
// /app/monthly?from=YYYY-MM-DD&to=YYYY-MM-DD (the Period P&L, merged
// in on 2026-11-27 — Monthly INVARIANTS "Any date range"). One month
// is the full page (Edit, Transactions); any other range is the same
// statement, read-only, from GET /monthly/range.
//
// Every figure is live: the server works the month out from both
// daily books, the bank feed and the return-check workflow on every
// read, so one day entered is enough for the month to show and a day
// entered later shows without anyone pressing Save (Monthly
// INVARIANTS.md "Daily feed"). Each line says where its figure comes
// from; lines at $0 are left out so the statement reads as what
// happened, not a form to fill in.

interface YearMonth { year: number; month: number; }

// Borrowed money and profit distributed count in total expenses
// (legacy P&L convention), so the Expenses statement lists them last.
// Over/short is income (an over is the store's money). Cash carry
// forward is in neither total: it is a KPI.
const INCOME_LINES = MONTHLY_LINES.filter((l) => l.section === "Income");
const EXPENSE_LINES = MONTHLY_LINES.filter(
  (l) => l.section === "Expenses"
    || (l.section === "Cash flow" && l.key !== "cash_carry_forward"),
);

const SOURCE_TONES: Record<ReturnType<typeof monthlyLineSource>, PillTone> = {
  daily: "info", bank: "info", returns: "info", typed: "neutral",
};

/** "Nov 2026" / "nov 2026": the short month name in the person's
 *  language, then the year. */
function shortMonthYear(year: number, month: number): string {
  return `${monthName(month, "short")} ${year}`;
}

export default function Monthly() {
  useT(); // re-render on a language switch
  const identity = getCurrentIdentity();
  const [sp, setSP] = useSearchParams();
  const months = useLoggedMonths();

  const yearParam  = sp.get("year");
  const monthParam = sp.get("month");
  const fromParam = sp.get("from");
  const toParam = sp.get("to");
  // Any days other than one whole month: the read-only range view.
  const range = useMemo<IsoRange | null>(() => {
    const isoDay = /^\d{4}-\d{2}-\d{2}$/;
    return fromParam && toParam && isoDay.test(fromParam) && isoDay.test(toParam)
      && fromParam <= toParam && !wholeMonth({ from: fromParam, to: toParam })
      ? { from: fromParam, to: toParam } : null;
  }, [fromParam, toParam]);

  // Default on first paint: the most recent month with anything in
  // it, else the current month — never a blank page. A range that is
  // one whole month opens as that month (Edit, Transactions).
  useEffect(() => {
    if (range) return;
    const asMonth = fromParam && toParam
      ? wholeMonth({ from: fromParam, to: toParam }) : null;
    if (asMonth) {
      setSP(new URLSearchParams({
        year: String(asMonth.year), month: String(asMonth.month),
      }), { replace: true });
      return;
    }
    if (yearParam && monthParam) return;
    const now = storeNow();
    const target = months.data?.months[0]
      ?? { year: now.getFullYear(), month: now.getMonth() + 1 };
    const params = new URLSearchParams(sp);
    params.set("year",  String(target.year));
    params.set("month", String(target.month));
    setSP(params, { replace: true });
  }, [range, fromParam, toParam, yearParam, monthParam, months.data, sp, setSP]);

  const year  = !range && yearParam ? Number(yearParam) : undefined;
  const month = !range && monthParam ? Number(monthParam) : undefined;
  const detail = useMonthly(year, month);
  const prev = year && month ? shiftMonth(year, month, -1) : undefined;
  const previous = useMonthly(prev?.year, prev?.month);
  const ranged = useMonthlyRange(range);

  function pickRange(next: IsoRange) {
    const asMonth = wholeMonth(next);
    setSP(new URLSearchParams(asMonth
      ? { year: String(asMonth.year), month: String(asMonth.month) }
      : { from: next.from, to: next.to }));
  }

  function goTo(ym: YearMonth) {
    const params = new URLSearchParams(sp);
    params.delete("from");
    params.delete("to");
    params.set("year", String(ym.year));
    params.set("month", String(ym.month));
    params.delete("page");
    setSP(params, { replace: true });
  }

  // The Transactions tab (Monthly INVARIANTS "Transactions"), for a
  // store with `pl_transactions` on. "" is the statement.
  // It lists bank rows, so it needs `bank_sync.read` too (the server
  // refuses it without; an accountant never has it).
  const withTransactions = Boolean(detail.data?.transactions_enabled)
    && hasPermission("bank_sync", "read");
  const tab = withTransactions && sp.get("tab") === "transactions" ? "transactions" : "";
  function openTab(next: "" | "transactions", line?: string) {
    const params = new URLSearchParams();
    params.set("year", String(year));
    params.set("month", String(month));
    if (next) params.set("tab", next);
    if (line) { params.set("line", line); params.set("view", "all"); }
    setSP(params);
  }
  const lineHref = withTransactions && year && month
    ? (key: string) => `/monthly?year=${year}&month=${month}&tab=transactions&view=all&line=${key}`
    : undefined;

  if (identity?.store_id == null) {
    return (
      <PageShell gap="1rem">
        <PageHeader title={navWord("Monthly P&L")} />
        <Empty>{t("pl.signInView")}</Empty>
      </PageShell>
    );
  }

  const monthLabel = range ? rangeLabel(range)
    : year && month ? shortMonthYear(year, month) : "—";
  const shown: IsoRange | null = range ?? (year && month ? monthRange(year, month) : null);

  return (
    <PageShell gap="1rem">

      <PageCrumbs under="/reports" current={navWord("Monthly P&L")} />

      <PageHeader
        title={navWord("Monthly P&L")}
        subtitle={<span className={styles.mono}>{monthLabel}</span>}
        actions={(
          <div className={styles.actions}>
            {year && month && shown && (
              <PeriodStepper
                unit="month"
                onPrev={() => goTo(shiftMonth(year, month, -1))}
                onNext={() => goTo(shiftMonth(year, month, 1))}
              >
                <DateRangePicker value={shown} onChange={pickRange} aria-label={t("pl.period")} />
              </PeriodStepper>
            )}
            {range && (
              <DateRangePicker value={range} onChange={pickRange} aria-label={t("pl.period")} />
            )}
            <ButtonLink to="/monthly/categories" tone="secondary" size="sm">
              {t("pl.categoriesButton")}
            </ButtonLink>
            {year && month && (
              <ButtonLink
                to={`/monthly/edit?year=${year}&month=${month}`}
                tone="primary"
                size="sm"
              >
                {t("common.edit")}
              </ButtonLink>
            )}
          </div>
        )}
      />

      {range && (
        <RangeView
          range={range}
          query={ranged}
        />
      )}
      {detail.isLoading && <Loading />}
      {detail.isError && (
        <ErrorState
          message={apiErrorMessage(detail.error, t("pl.loadFailed"))}
          onRetry={() => { void detail.refetch(); }}
        />
      )}
      {detail.data?.report == null && !detail.isLoading && !detail.isError
        && year && month && (
        <Card>
          <EmptyState
            title={t("pl.nothingYet", { month: monthLabel })}
            body={t("pl.nothingYetBody")}
            cta={(
              <ButtonLink to="/daily" tone="secondary" size="sm">
                {t("pl.openDaily")}
              </ButtonLink>
            )}
          />
        </Card>
      )}
      {detail.data?.report && withTransactions && (
        <TabsBar>
          <TabsButton active={tab === ""} onClick={() => openTab("")}>
            {t("plTx.tabStatement")}
          </TabsButton>
          <TabsButton active={tab === "transactions"} onClick={() => openTab("transactions")}>
            {t("plTx.tabTransactions")}
          </TabsButton>
        </TabsBar>
      )}
      {detail.data?.report && tab === "" && (
        <ReportContent
          r={detail.data.report}
          labels={detail.data.labels}
          previous={previous.data?.report ?? null}
          previousLabel={prev ? monthName(prev.month, "short") : ""}
          lineHref={lineHref}
        />
      )}
      {detail.data?.report && tab === "transactions" && year && month && (
        <PLTransactions year={year} month={month} labels={detail.data.labels} />
      )}
    </PageShell>
  );
}

/** Any days other than one month: the statement, read-only, with a
 *  note naming the typed figures a cut month leaves out. */
function RangeView({
  range, query,
}: {
  range: IsoRange;
  query: ReturnType<typeof useMonthlyRange>;
}) {
  useT();
  if (query.isLoading) return <Loading />;
  if (query.isError) {
    return (
      <ErrorState
        message={apiErrorMessage(query.error, t("pl.loadFailed"))}
        onRetry={() => { void query.refetch(); }}
      />
    );
  }
  const data = query.data;
  if (!data) return null;
  return (
    <>
      <Alert tone="info">
        {t("pl.rangeReadOnly", { range: rangeLabel(range) })}
      </Alert>
      {data.left_out.length > 0 && (
        <Alert tone="warning">
          <span className={styles.leftOutTitle}>{t("pl.rangeLeftOut")}</span>
          <ul className={styles.leftOut}>
            {data.left_out.map((x: MonthlyLeftOut) => (
              <li key={`${x.year}-${x.month}-${x.line}`}>
                {t("pl.rangeLeftOutLine", {
                  line: monthlyLineName(x.line, data.labels[x.line]),
                  amount: fmtMoney2(x.amount),
                  month: shortMonthYear(x.year, x.month),
                })}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <ReportContent
        r={data.report} labels={data.labels} previous={null} previousLabel=""
        readOnly
      />
    </>
  );
}

function ReportContent({
  r, labels, previous, previousLabel, lineHref, readOnly = false,
}: {
  r: MonthlyRow;
  /** The store's own name per P&L column, from the server. */
  labels: Record<string, string>;
  previous: MonthlyRow | null;
  previousLabel: string;
  /** With the Transactions tab: where a line's rows are listed. */
  lineHref?: (key: string) => string;
  /** A date range: nothing here is edited, so no "add under Edit". */
  readOnly?: boolean;
}) {
  const margin = r.total_income > 0
    ? Math.round((r.net_profit / r.total_income) * 1000) / 10
    : null;
  const vsPrev = (now: number, before: number | undefined) =>
    previous && before !== undefined
      ? <Delta value={now - before} money suffix={t("pl.vsPrevious", { month: previousLabel })} />
      : undefined;

  return (
    <>
      <p className={styles.status}>
        <Pill tone="accent" dot>{t("pl.live")}</Pill>
        <span>
          {r.days_entered > 0
            ? tn("pl.builtFrom", r.days_entered, fmtNumber)
            : t("pl.noDays")}
          {!readOnly && !r.saved && r.days_entered > 0 && t("pl.addUnderEdit")}
        </span>
      </p>

      <KpiGrid minWidth="12rem">
        <KpiCard
          label={t("pl.totalIncome")}
          value={fmtMoney2(r.total_income)}
          tone="positive"
          sub={vsPrev(r.total_income, previous?.total_income)}
        />
        <KpiCard
          label={t("pl.totalExpenses")}
          value={fmtMoney2(r.total_expenses)}
          sub={vsPrev(r.total_expenses, previous?.total_expenses)}
        />
        <KpiCard
          label={t("pl.netProfit")}
          value={fmtMoney2(r.net_profit)}
          tone={r.net_profit >= 0 ? "positive" : "negative"}
          colorValue
          sub={(
            <span className={styles.subStack}>
              {margin != null && <span>{t("pl.ofIncome", { pct: margin })}</span>}
              {vsPrev(r.net_profit, previous?.net_profit)}
            </span>
          )}
        />
        {r.cash_carry_forward !== 0 && (
          <KpiCard
            label={t("pl.line.cash_carry_forward")}
            value={fmtMoney2(r.cash_carry_forward)}
          />
        )}
      </KpiGrid>

      <div className={styles.statements}>
        <Section title={t(MONTHLY_SECTION_LABELS.Income)}>
          <Statement
            r={r} labels={labels} lines={INCOME_LINES} lineHref={lineHref}
            custom={(r.custom_lines ?? []).filter((c) => c.section === "income")}
            total={r.total_income} totalLabel="pl.totalIncome"
          />
        </Section>
        <Section title={t(MONTHLY_SECTION_LABELS.Expenses)}>
          <Statement
            r={r} labels={labels} lines={EXPENSE_LINES} lineHref={lineHref}
            custom={(r.custom_lines ?? []).filter((c) => c.section === "expense")}
            total={r.total_expenses} totalLabel="pl.totalExpenses"
          />
        </Section>
      </div>

      {r.notes && (
        <Section title={t("pl.notes")}>
          <Card>
            <p className={styles.notes}>{r.notes}</p>
          </Card>
        </Section>
      )}
    </>
  );
}

/** One half of the P&L as a statement: every line with a figure, a
 *  pill saying where it comes from, and the half's total. Lines at
 *  $0 are left out (a line that does not apply disappears rather
 *  than show $0); a footnote says how many. */
function Statement({
  r, labels, lines, custom = [], total, totalLabel, lineHref,
}: {
  r: MonthlyRow;
  labels: Record<string, string>;
  lines: MonthlyLine[];
  /** The store's own categories with a figure in this half
   *  (`pl_transactions`), fed from the bank. */
  custom?: MonthlyCustomLine[];
  total: number;
  totalLabel: MessageKey;
  lineHref?: (key: string) => string;
}) {
  const t = useT();
  const shown = lines.filter((l) => Number(r[l.key]) !== 0);
  const hidden = lines.length - shown.length;
  return (
    <Card>
      {shown.length === 0 && custom.length === 0 ? (
        <Empty>{t("pl.nothingThisMonth")}</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th style={thStyle}>{t("pl.colLine")}</th>
              <th style={thStyle}>{t("pl.colFrom")}</th>
              <th style={thStyleRight}>{t("pl.colAmount")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => {
              const source = monthlyLineSource(r, l.key);
              return (
                <tr key={l.key}>
                  <td style={tdStyle}>
                    <span className={styles.lineName}>
                      {lineHref ? (
                        <AppLink
                          to={lineHref(l.key)}
                          title={t("plTx.openLine", { line: monthlyLineName(l.key, labels[l.key]) })}
                        >
                          {monthlyLineName(l.key, labels[l.key])}
                        </AppLink>
                      ) : monthlyLineName(l.key, labels[l.key])}
                    </span>
                    {l.key === "money_order_fees" && r.money_order_charges > 0 && (
                      <span className={styles.lineNote}>
                        {tn("pl.moCharges", r.money_order_count, fmtNumber, {
                          amount: fmtMoney2(r.money_order_charges),
                        })}
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <Pill tone={SOURCE_TONES[source]}>
                      {t(MONTHLY_SOURCE_LABELS[source])}
                    </Pill>
                  </td>
                  <td style={tdStyleRight} className={styles.amount}>
                    {fmtMoney2(Number(r[l.key]))}
                  </td>
                </tr>
              );
            })}
            {custom.map((c) => (
              <tr key={c.slug}>
                <td style={tdStyle}>
                  <span className={styles.lineName}>
                    {lineHref ? (
                      <AppLink
                        to={lineHref(c.slug)}
                        title={t("plTx.openLine", { line: c.name })}
                      >
                        {c.name}
                      </AppLink>
                    ) : c.name}
                  </span>
                </td>
                <td style={tdStyle}>
                  <Pill tone={SOURCE_TONES.bank}>
                    {t(MONTHLY_SOURCE_LABELS.bank)}
                  </Pill>
                </td>
                <td style={tdStyleRight} className={styles.amount}>
                  {fmtMoney2(c.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={tdStyle} className={styles.totalCell} colSpan={2}>
                {t(totalLabel)}
              </td>
              <td style={tdStyleRight} className={`${styles.amount} ${styles.totalCell}`}>
                {fmtMoney2(total)}
              </td>
            </tr>
          </tfoot>
        </Table>
      )}
      {hidden > 0 && (
        <p className={styles.footnote}>
          {tn("pl.hiddenLines", hidden, fmtNumber)}
        </p>
      )}
    </Card>
  );
}
