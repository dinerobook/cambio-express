import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import {
  MONTHLY_LINES, MONTHLY_SECTION_LABELS, MONTHLY_SOURCE_LABELS,
  monthlyLineName, monthlyLineSource,
  useLoggedMonths, useMonthly, type MonthlyLine, type MonthlyRow,
} from "../api/monthly";
import { Delta } from "../components/Delta";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  ButtonLink, Card, Empty, EmptyState, ErrorState, Loading, PageHeader,
  KpiCard, KpiGrid, PageShell, PeriodStepper, Pill, Section, Select, Table,
  tdStyle, tdStyleRight, thStyle, thStyleRight,
  type PillTone,
} from "../components/ui";
import styles from "./Monthly.module.css";
import { monthName, shiftMonth, storeNow } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// Monthly P&L at /app/monthly?year=Y&month=M.
//
// Every figure is live: the server works the month out from both
// daily books, the bank feed and the return-check workflow on every
// read, so one day entered is enough for the month to show and a day
// entered later shows without anyone pressing Save (Monthly
// INVARIANTS.md "Daily feed"). Each line says where its figure comes
// from; lines at $0 are left out so the statement reads as what
// happened, not a form to fill in.

interface YearMonth { year: number; month: number; }

// The month picker must always be usable. Offer the current month +
// the previous 11, merged with every month the server knows of (a
// saved P&L or a day in either daily book), newest first.
function buildMonthOptions(logged: YearMonth[]): YearMonth[] {
  const seen = new Map<string, YearMonth>();
  const now = storeNow();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym: YearMonth = { year: d.getFullYear(), month: d.getMonth() + 1 };
    seen.set(`${ym.year}-${ym.month}`, ym);
  }
  for (const lm of logged) seen.set(`${lm.year}-${lm.month}`, lm);
  return [...seen.values()].sort(
    (a, b) => b.year - a.year || b.month - a.month,
  );
}

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
  const monthOptions = useMemo(
    () => buildMonthOptions(months.data?.months ?? []),
    [months.data],
  );

  // Default on first paint: the most recent month with anything in
  // it, else the current month — never a blank page.
  useEffect(() => {
    if (yearParam && monthParam) return;
    const now = storeNow();
    const target = months.data?.months[0]
      ?? { year: now.getFullYear(), month: now.getMonth() + 1 };
    const params = new URLSearchParams(sp);
    params.set("year",  String(target.year));
    params.set("month", String(target.month));
    setSP(params, { replace: true });
  }, [yearParam, monthParam, months.data, sp, setSP]);

  const year  = yearParam ? Number(yearParam) : undefined;
  const month = monthParam ? Number(monthParam) : undefined;
  const detail = useMonthly(year, month);
  const prev = year && month ? shiftMonth(year, month, -1) : undefined;
  const previous = useMonthly(prev?.year, prev?.month);

  function goTo(ym: YearMonth) {
    const params = new URLSearchParams(sp);
    params.set("year", String(ym.year));
    params.set("month", String(ym.month));
    setSP(params, { replace: true });
  }

  if (identity?.store_id == null) {
    return (
      <PageShell gap="1rem">
        <PageHeader title={navWord("Monthly P&L")} />
        <Empty>{t("pl.signInView")}</Empty>
      </PageShell>
    );
  }

  const monthLabel = year && month ? shortMonthYear(year, month) : "—";

  return (
    <PageShell gap="1rem">

      <PageCrumbs under="/reports" current={navWord("Monthly P&L")} />

      <PageHeader
        title={navWord("Monthly P&L")}
        subtitle={<span className={styles.mono}>{monthLabel}</span>}
        actions={(
          <div className={styles.actions}>
            {year && month && (
              <PeriodStepper
                unit="month"
                onPrev={() => goTo(shiftMonth(year, month, -1))}
                onNext={() => goTo(shiftMonth(year, month, 1))}
              >
                <Select
                  aria-label={t("pl.month")}
                  value={`${year}-${month}`}
                  onChange={(e) => {
                    const [y, m] = e.target.value.split("-").map(Number);
                    if (y && m) goTo({ year: y, month: m });
                  }}
                  style={{ width: "auto" }}
                >
                  {monthOptions.map((m) => (
                    <option
                      key={`${m.year}-${m.month}`}
                      value={`${m.year}-${m.month}`}
                    >
                      {shortMonthYear(m.year, m.month)}
                    </option>
                  ))}
                </Select>
              </PeriodStepper>
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
      {detail.data?.report && (
        <ReportContent
          r={detail.data.report}
          labels={detail.data.labels}
          previous={previous.data?.report ?? null}
          previousLabel={prev ? monthName(prev.month, "short") : ""}
        />
      )}
    </PageShell>
  );
}

function ReportContent({
  r, labels, previous, previousLabel,
}: {
  r: MonthlyRow;
  /** The store's own name per P&L column, from the server. */
  labels: Record<string, string>;
  previous: MonthlyRow | null;
  previousLabel: string;
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
          {!r.saved && r.days_entered > 0 && t("pl.addUnderEdit")}
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
            r={r} labels={labels} lines={INCOME_LINES}
            total={r.total_income} totalLabel="pl.totalIncome"
          />
        </Section>
        <Section title={t(MONTHLY_SECTION_LABELS.Expenses)}>
          <Statement
            r={r} labels={labels} lines={EXPENSE_LINES}
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
  r, labels, lines, total, totalLabel,
}: {
  r: MonthlyRow;
  labels: Record<string, string>;
  lines: MonthlyLine[];
  total: number;
  totalLabel: MessageKey;
}) {
  const t = useT();
  const shown = lines.filter((l) => Number(r[l.key]) !== 0);
  const hidden = lines.length - shown.length;
  return (
    <Card>
      {shown.length === 0 ? (
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
                      {monthlyLineName(l.key, labels[l.key])}
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
