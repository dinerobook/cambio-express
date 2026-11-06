import { useSearchParams } from "react-router-dom";

import { useStoreBookMonth } from "../api/storebook";
import {
  Card, ErrorState, KpiCard, KpiGrid, Loading,
  MonthCalendar, PageHeader, PageShell, PeriodStepper, Select,
} from "../components/ui";
import { fmtMoney2 } from "../lib/formatters";
import {
  formatMonthYear, monthName, shiftMonth, storeNow, todayIso,
} from "../lib/datetime";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";
import { PageCrumbs } from "../components/PageCrumbs";

// /app/store-book — the month calendar. One cell per day with its
// sales total and lock state; click through to the day sheet.

export default function StoreBookMonth() {
  const t = useT();
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
      <PageCrumbs />
      <PageHeader
        title={navWord("Store daily book")}
        subtitle={formatMonthYear(year, month)}
        actions={
          <PeriodStepper
            unit="month"
            onPrev={() => shift(-1)}
            onNext={() => shift(1)}
          >
            <Select
              aria-label={t("sbMonth.month")}
              value={month}
              onChange={(e) => goToMonth(year, Number(e.target.value))}
              style={{ width: "auto" }}
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>{monthName(i + 1)}</option>
              ))}
            </Select>
          </PeriodStepper>
        }
      />

      {data && (
        <KpiGrid>
          <KpiCard
            label={t("sbMonth.totalSales")}
            value={fmtMoney2(data.total_sales_cents / 100)}
          />
          <KpiCard
            label={t("sbMonth.totalGallons")}
            value={data.total_fuel_gallons.toLocaleString()}
          />
          <KpiCard
            label={t("sbMonth.totalFuel")}
            value={fmtMoney2(data.total_fuel_cents / 100)}
          />
        </KpiGrid>
      )}

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={t("sbMonth.loadFailed")}
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
            ariaLabelFor={(iso) => t("sbMonth.openDay", { date: iso })}
            dayFor={(iso) => {
              const row = byDate.get(iso);
              if (!row) return undefined;
              return {
                hasData: true,
                locked: row.is_locked,
                primary: fmtMoney2(row.sales_cents / 100),
                variance: row.over_short_cents / 100,
                varianceTitle: t("sbMonth.overShortTitle"),
              };
            }}
          />
        </Card>
      )}

    </PageShell>
  );
}
