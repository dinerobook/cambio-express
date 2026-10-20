import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import {
  MONTHLY_LINES, MONTHLY_SOURCE_LABELS, monthlyLineSource,
  useLoggedMonths, useMonthly, type MonthlyLine, type MonthlyRow,
} from "../api/monthly";
import { Delta } from "../components/Delta";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  Breadcrumbs,
  ButtonLink, Card, Empty, EmptyState, ErrorState, Loading, PageHeader,
  KpiCard, KpiGrid, PageShell, PeriodStepper, Pill, Section, Select, Table,
  tdStyle, tdStyleRight, thStyle, thStyleRight,
  type PillTone,
} from "../components/ui";
import styles from "./Monthly.module.css";
import {
  MONTH_NAMES_SHORT, shiftMonth, storeNow,
} from "../lib/datetime";

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

// Over/short, borrowed money and profit distributed count in total
// expenses (legacy P&L convention), so the Expenses statement lists
// them last. Cash carry forward is in neither total: it is a KPI.
const INCOME_LINES = MONTHLY_LINES.filter((l) => l.section === "Income");
const EXPENSE_LINES = MONTHLY_LINES.filter(
  (l) => l.section === "Expenses"
    || (l.section === "Cash flow" && l.key !== "cash_carry_forward"),
);

const SOURCE_TONES: Record<ReturnType<typeof monthlyLineSource>, PillTone> = {
  daily: "info", bank: "info", returns: "info", typed: "neutral",
};

export default function Monthly() {
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
        <PageHeader title="Monthly P&L" />
        <Empty>Sign in as a store admin to view monthly P&amp;L.</Empty>
      </PageShell>
    );
  }

  const monthLabel = year && month ? `${MONTH_NAMES_SHORT[month - 1]} ${year}` : "—";

  return (
    <PageShell gap="1rem">

      <Breadcrumbs crumbs={[
        { label: "Reports", to: "/reports" },
        { label: "Monthly P&L" },
      ]} />

      <PageHeader
        title="Monthly P&L"
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
                  aria-label="Month"
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
                      {MONTH_NAMES_SHORT[m.month - 1]} {m.year}
                    </option>
                  ))}
                </Select>
              </PeriodStepper>
            )}
            <ButtonLink to="/monthly/categories" tone="secondary" size="sm">
              Categories
            </ButtonLink>
            {year && month && (
              <ButtonLink
                to={`/monthly/edit?year=${year}&month=${month}`}
                tone="primary"
                size="sm"
              >
                Edit
              </ButtonLink>
            )}
          </div>
        )}
      />

      {detail.isLoading && <Loading />}
      {detail.isError && (
        <ErrorState
          message={apiErrorMessage(detail.error, "Could not load monthly report")}
          onRetry={() => { void detail.refetch(); }}
        />
      )}
      {detail.data?.report == null && !detail.isLoading && !detail.isError
        && year && month && (
        <Card>
          <EmptyState
            title={`Nothing recorded for ${monthLabel} yet.`}
            body="Enter a day in the daily book and this month's P&L fills in by itself."
            cta={(
              <ButtonLink to="/daily" tone="secondary" size="sm">
                Open the daily book
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
          previousLabel={prev ? MONTH_NAMES_SHORT[prev.month - 1] : ""}
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
      ? <Delta value={now - before} money suffix={` vs ${previousLabel}`} />
      : undefined;

  return (
    <>
      <p className={styles.status}>
        <Pill tone="accent" dot>Live</Pill>
        <span>
          {r.days_entered > 0
            ? `Built from ${fmtNumber(r.days_entered)} day${r.days_entered === 1 ? "" : "s"} entered in the daily books. It updates as you enter more.`
            : "No daily book days this month. Showing what was saved."}
          {!r.saved && r.days_entered > 0
            && " Rent, payroll tax and other lines the daily book can't know are added under Edit."}
        </span>
      </p>

      <KpiGrid minWidth="12rem">
        <KpiCard
          label="Total income"
          value={fmtMoney2(r.total_income)}
          tone="positive"
          sub={vsPrev(r.total_income, previous?.total_income)}
        />
        <KpiCard
          label="Total expenses"
          value={fmtMoney2(r.total_expenses)}
          sub={vsPrev(r.total_expenses, previous?.total_expenses)}
        />
        <KpiCard
          label="Net profit"
          value={fmtMoney2(r.net_profit)}
          tone={r.net_profit >= 0 ? "positive" : "negative"}
          colorValue
          sub={(
            <span className={styles.subStack}>
              {margin != null && <span>{margin}% of income</span>}
              {vsPrev(r.net_profit, previous?.net_profit)}
            </span>
          )}
        />
        {r.cash_carry_forward !== 0 && (
          <KpiCard
            label="Cash carry forward"
            value={fmtMoney2(r.cash_carry_forward)}
          />
        )}
      </KpiGrid>

      <div className={styles.statements}>
        <Section title="Income">
          <Statement
            r={r} labels={labels} lines={INCOME_LINES}
            total={r.total_income} totalLabel="Total income"
          />
        </Section>
        <Section title="Expenses">
          <Statement
            r={r} labels={labels} lines={EXPENSE_LINES}
            total={r.total_expenses} totalLabel="Total expenses"
          />
        </Section>
      </div>

      {r.notes && (
        <Section title="Notes">
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
  totalLabel: string;
}) {
  const shown = lines.filter((l) => Number(r[l.key]) !== 0);
  const hidden = lines.length - shown.length;
  return (
    <Card>
      {shown.length === 0 ? (
        <Empty>Nothing yet this month.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th style={thStyle}>Line</th>
              <th style={thStyle}>From</th>
              <th style={thStyleRight}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => {
              const source = monthlyLineSource(r, l.key);
              return (
                <tr key={l.key}>
                  <td style={tdStyle}>
                    <span className={styles.lineName}>
                      {labels[l.key] || l.label}
                    </span>
                    {l.key === "money_order_fees" && r.money_order_charges > 0 && (
                      <span className={styles.lineNote}>
                        After {fmtMoney2(r.money_order_charges)} company charges
                        on {fmtNumber(r.money_order_count)} money orders
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <Pill tone={SOURCE_TONES[source]}>
                      {MONTHLY_SOURCE_LABELS[source]}
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
                {totalLabel}
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
          {hidden} line{hidden === 1 ? "" : "s"} at $0 not shown.
        </p>
      )}
    </Card>
  );
}
