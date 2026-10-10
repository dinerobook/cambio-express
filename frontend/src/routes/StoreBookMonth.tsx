import { useSearchParams } from "react-router-dom";

import { useStoreBookMonth } from "../api/storebook";
import {
  Breadcrumbs, Card, ErrorState, KpiCard, KpiGrid, Loading,
  MonthCalendar, PageHeader, PageShell, PeriodStepper, Select,
} from "../components/ui";
import { fmtMoney2 } from "../lib/formatters";
import {
  MONTH_NAMES, shiftMonth, storeNow, todayIso,
} from "../lib/datetime";

// /app/store-book — the month calendar. One cell per day with its
// sales total and lock state; click through to the day sheet.

export default function StoreBookMonth() {
  const [sp, setSP] = useSearchParams();
  const now = storeNow();
  const year = Number(sp.get("year") ?? now.getFullYear());
  const month = Number(sp.get("month") ?? now.getMonth() + 1);

  const { data, isLoading, isError, refetch } =
    useStoreBookMonth(year, month);

  function goToMonth(y: number, m: number) {
    const next = new URLSearchParams(sp);
    next.set("year", String(y));
    next.set("month", String(m));
    setSP(next, { replace: true });
  }

  function shift(delta: number) {
    const next = shiftMonth(year, month, delta);
    goToMonth(next.year, next.month);
  }

  const byDate = new Map(
    (data?.rows ?? []).map((r) => [r.entry_date, r]),
  );

  return (
    <PageShell>
      <Breadcrumbs crumbs={[{ label: "Daily book" }]} />
      <PageHeader
        title="Daily book"
        subtitle={`${MONTH_NAMES[month - 1]} ${year}`}
        actions={
          <PeriodStepper
            unit="month"
            onPrev={() => shift(-1)}
            onNext={() => shift(1)}
          >
            <Select
              aria-label="Month"
              value={month}
              onChange={(e) => goToMonth(year, Number(e.target.value))}
              style={{ width: "auto" }}
            >
              {MONTH_NAMES.map((label, i) => (
                <option key={i + 1} value={i + 1}>{label}</option>
              ))}
            </Select>
          </PeriodStepper>
        }
      />

      {data && (
        <KpiGrid>
          <KpiCard
            label="Total sales"
            value={fmtMoney2(data.total_sales_cents / 100)}
          />
          <KpiCard
            label="Total gallons"
            value={data.total_fuel_gallons.toLocaleString()}
          />
          <KpiCard
            label="Total fuel"
            value={fmtMoney2(data.total_fuel_cents / 100)}
          />
        </KpiGrid>
      )}

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message="Couldn't load this month."
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <Card>
          <MonthCalendar
            year={year}
            month={month}
            today={todayIso()}
            hrefFor={(iso) => `/store-book/day?date=${iso}`}
            ariaLabelFor={(iso) => `Open the daily book for ${iso}`}
            dayFor={(iso) => {
              const row = byDate.get(iso);
              if (!row) return undefined;
              return {
                hasData: true,
                locked: row.is_locked,
                primary: fmtMoney2(row.sales_cents / 100),
                variance: row.over_short_cents / 100,
                varianceTitle: "Over/short for the day",
              };
            }}
          />
        </Card>
      )}

    </PageShell>
  );
}
