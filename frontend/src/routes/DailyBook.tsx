import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { useDailyPeriod, type DailyReportRow } from "../api/dailybook";
import { apiErrorMessage } from "../lib/api";
import { fmtMoney, fmtMoney2 } from "../lib/formatters";
import {
  ButtonLink, Card, ErrorState, KpiCard, KpiGrid, Loading,
  MonthCalendar, MonthCalendarLegend, PageHeader, PageShell, PeriodStepper,
} from "../components/ui";
import { canAccess } from "../lib/access";
import {
  MONTH_NAMES, daysInMonth, monthRangeIso, shiftMonth, storeNow, todayIso,
} from "../lib/datetime";

// /app/daily — the Daily Book landing page. A calendar of the
// chosen month + a monthly summary strip. Each day cell is a link
// to /app/daily/edit?date=YYYY-MM-DD where the per-day editor
// lives. Mirrors the legacy Jinja `/daily` UX: pick the day from
// the calendar, then enter that day's book.

export default function DailyBook() {
  const [params, setParams] = useSearchParams();

  // Read year+month from the URL. Default to current month so the
  // page is shareable + bookmarkable per month.
  const now = useMemo(() => storeNow(), []);
  const yearParam = parseInt(params.get("year") || "", 10);
  const monthParam = parseInt(params.get("month") || "", 10);
  const year = Number.isFinite(yearParam) && yearParam > 1970
    ? yearParam
    : now.getFullYear();
  // 1-12, as the URL and every lib/datetime month helper take it.
  const month = Number.isFinite(monthParam) && monthParam >= 1 && monthParam <= 12
    ? monthParam
    : now.getMonth() + 1;

  const { from, to } = monthRangeIso(year, month);

  const { data, isLoading, isError, error, refetch } = useDailyPeriod(
    from, to,
  );

  const reportByDate = useMemo(() => {
    const m = new Map<string, DailyReportRow>();
    for (const row of data?.rows ?? []) m.set(row.report_date, row);
    return m;
  }, [data]);

  function navMonth(delta: number) {
    const next = shiftMonth(year, month, delta);
    const p = new URLSearchParams(params);
    p.set("year", String(next.year));
    p.set("month", String(next.month));
    setParams(p, { replace: true });
  }

  const today = todayIso();

  return (
    <PageShell gap="1.5rem">

      <PageHeader
        title="MSB Daily book"
        subtitle={`${MONTH_NAMES[month - 1]} ${year}`}
        actions={(
          <PeriodStepper
            unit="month"
            onPrev={() => navMonth(-1)}
            onNext={() => navMonth(1)}
          >
            <ButtonLink
              to={`/daily/edit?date=${today}`}
              tone="secondary" size="sm"
              title="Open today's daily book"
            >
              Today
            </ButtonLink>
          </PeriodStepper>
        )}
      />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={apiErrorMessage(error, "Could not load month.")}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <KpiGrid minWidth="180px">
          <KpiCard
            label="Days logged"
            value={`${data.days_logged} / ${daysInMonth(year, month)}`}
          />
          <KpiCard
            label="Total in"
            value={fmtMoney(data.total_receipts)}
            tone="positive"
          />
          <KpiCard
            label="Total out"
            value={fmtMoney(data.total_disbursements)}
          />
          <KpiCard
            label="Net"
            value={fmtMoney(data.net)}
            tone={data.net >= 0 ? "positive" : "negative"}
          />
        </KpiGrid>
      )}

      {data && (
        <Card padding="clamp(0.5rem, 2.5vw, 1.25rem)">
          <Calendar
            year={year}
            month={month}
            today={today}
            reportByDate={reportByDate}
          />
          <MonthCalendarLegend />
        </Card>
      )}
    </PageShell>
  );
}


// The month grid itself is the shared kit component — the store
// daily book renders the same one. This page only says what a day
// CONTAINS; how a day looks lives in MonthCalendar.

function Calendar({
  year, month, today, reportByDate,
}: {
  year: number;
  /** 1-12. */
  month: number;
  today: string;
  reportByDate: Map<string, DailyReportRow>;
}) {
  return (
    <MonthCalendar
      year={year}
      month={month}
      today={today}
      hrefFor={(iso) => (canAccess("/daily/edit") ? `/daily/edit?date=${iso}` : null)}
      ariaLabelFor={(iso) => `Open daily book for ${iso}`}
      dayFor={(iso) => {
        const report = reportByDate.get(iso);
        if (!report) return undefined;
        const total =
          (report.total_receipts ?? 0) - (report.total_disbursements ?? 0);
        const over = report.over_short ?? 0;
        return {
          hasData: true,
          locked: Boolean(report.locked),
          primary: fmtMoney(total),
          variance: over,
          varianceTitle: `Over/short: ${fmtMoney2(over)}`,
        };
      }}
    />
  );
}


