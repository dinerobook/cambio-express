import { Navigate } from "react-router-dom";
import {
  CategoryScale, Chart as ChartJS, Filler, LinearScale, LineElement,
  PointElement, Tooltip as ChartTooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";

import { PeriodRollup } from "../components/PeriodRollup";
import {
  RecentReceipts, RegisterActivityTiles,
} from "../components/RegisterActivity";

import {
  useDashboardSummary,
  type AdminDashboard,
  type EmployeeDashboard,
  type DashboardSummary,
} from "../api/dashboard";
import { chartSeries, moneyChartOptions, seriesFill } from "../lib/chartOptions";

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement, Filler,
  ChartTooltip,
);
import { useStoreInfo } from "../api/account";
import { AppLink,
  ButtonLink,
  Card,
  ErrorState,
  KpiCard,
  KpiGrid,
  Loading,
  PageHeader,
  PageShell,
  Pill,
  Section,
  Table,
  TableSkeleton,
  fontSize,
  space,
  tokens,
  Empty,
  type PillTone,
} from "../components/ui";
import { BATCH_STATUS_TONES, batchStatusLabel } from "../api/batches";
import { TRANSFER_STATUS_TONES } from "../api/transfers";
import { statusLabel } from "../lib/transferKinds";
import { tn, useT } from "../i18n";
import TransferKindPill from "../components/TransferKindPill";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  formatDateTime, formatShortDate, formatTime, getOpenStatus, monthName,
  weekdayNameLong,
} from "../lib/datetime";
import { fmtMoney, fmtMoney2, fmtNumber } from "../lib/formatters";

// Role-shaped dashboard. /api/v2/dashboard/summary returns one
// payload tagged by role; we render the matching panel.
//
// Owner sessions have no `store_id` on their JWT (they live across
// every store under their umbrella), so /api/v2/dashboard/summary
// 400s for them. The Flask /dashboard route already handles this
// by redirecting owners to /owner/dashboard; mirror that in the
// SPA so owners who hit /app/dashboard directly (post-login,
// bookmark, hard refresh) land on their own dashboard.
export default function Dashboard() {
  const t = useT();
  const identity = getCurrentIdentity();
  // Hooks must be called unconditionally before any early return —
  // the owner-redirect branch below uses `<Navigate>` to short-circuit
  // *render*, but the hook itself still fires. TanStack Query reads
  // the role from getCurrentIdentity() and skips the request when
  // owner-shaped JWTs are detected via its own `enabled` flag (see
  // useDashboardSummary in ../api/dashboard.ts).
  const { data, isLoading, isError, error, refetch } = useDashboardSummary();
  // Store-info lookup powers the "Open now" pill. Owners /
  // superadmin (no store_id on the JWT) are excluded; the hook
  // gates itself.
  const { data: storeInfo } = useStoreInfo();
  const openStatus = identity?.role !== "superadmin"
    ? getOpenStatus(
        storeInfo?.store?.store_hours,
        storeInfo?.store?.timezone,
      )
    : null;

  if (identity?.role === "owner") {
    return <Navigate to="/owner/dashboard" replace />;
  }

  if (identity?.role === "superadmin") {
    return <Navigate to="/superadmin/dashboard" replace />;
  }

  if (identity?.role === "support") {
    // Tickets-only platform role — the ticket queue IS its home.
    return <Navigate to="/superadmin/tickets" replace />;
  }

  const title = identity?.role === "employee" ? t("dash.myTitle") : t("dash.title");

  return (
    <PageShell>

      <PageHeader
        title={title}
        actions={openStatus ? (
          <span
            title={
              openStatus.todayLabel
                ? t("transfer.outOfHoursOpen", {
                    day: weekdayNameLong(openStatus.dayIndex),
                    hours: openStatus.todayLabel,
                  })
                : t("dash.closedAllDay", { day: weekdayNameLong(openStatus.dayIndex) })
            }
          >
            <Pill tone={openStatus.open ? "accent" : "neutral"}>
              {openStatus.open ? t("dash.openNow") : t("dash.closedNow")}
            </Pill>
          </span>
        ) : undefined}
      />

      {isLoading && (
        <Card>
          <Loading label={t("dash.loading")} />
          <div style={{ marginTop: space.md }}>
            <TableSkeleton rows={4} cols={3} />
          </div>
        </Card>
      )}

      {isError && (
        <ErrorState
          message={
            t("dash.loadFailed", {
              reason: apiErrorMessage(error, t("dash.unknownError")),
            })
          }
          onRetry={() => refetch()}
        />
      )}

      {data && <Body summary={data} />}
    </PageShell>
  );
}

function Body({ summary }: { summary: DashboardSummary }) {
  const t = useT();
  if (summary.role === "admin") return <AdminPanel d={summary} />;
  if (summary.role === "employee") return <EmployeePanel d={summary} />;
  // A superadmin is sent to /superadmin/dashboard before this
  // renders; their platform figures live on Platform → Controls.
  return <ErrorState message={t("dash.unknownRole")} />;
}

// ── Admin ─────────────────────────────────────────────────────

function AdminPanel({ d }: { d: AdminDashboard }) {
  const t = useT();
  const month = monthName(Number(d.today.slice(5, 7)), "short");
  // Module-driven layout (P1-10 → D-1): the dashboard leads with
  // generic STORE numbers (sales, purchases, labor); each module
  // contributes its section; money services is one module section
  // among many, not the headline.
  const ms = d.modules.includes("module_money_services");
  const hasTrend = d.sales?.trend.some((p) => p.amount > 0) ?? false;
  return (
    <>
      <KpiGrid>
        {d.sales && (
          <>
            <KpiCard
              label={t("dash.todaySales")}
              value={fmtMoney2(d.sales.today)}
              sub={
                <AppLink to="/store-book" className="ds-link" style={{ color: tokens.accent }}>
                  {t("dash.openDailyBook")}
                </AppLink>
              }
              tone="positive"
            />
            <KpiCard
              label={t("dash.yesterdaySales")}
              value={fmtMoney2(d.sales.yesterday)}
              sub={formatShortDate(d.today)}
            />
            <KpiCard
              label={t("dash.salesMonthToDate", { month })}
              value={fmtMoney2(d.sales.month_to_date)}
              tone="positive"
            />
          </>
        )}
        {d.day_close && (
          <KpiCard
            label={t("dash.drawerOverShort")}
            value={
              d.day_close.over_short == null
                ? "—"
                : fmtMoney2(d.day_close.over_short)
            }
            sub={
              d.day_close.uncounted_drawers > 0
                ? tn("dash.drawersUncounted", d.day_close.uncounted_drawers, fmtNumber)
                : t("dash.allDrawersCounted")
            }
            tone={
              d.day_close.uncounted_drawers > 0
              || (d.day_close.over_short ?? 0) !== 0
                ? "warning" : "positive"
            }
          />
        )}
        {d.lottery && (
          <KpiCard
            label={t("dash.lotteryOn", { date: formatShortDate(d.lottery.date) })}
            value={fmtMoney2(d.lottery.value)}
            sub={
              d.lottery.uncounted_active_packs > 0
                ? tn("dash.packsUncounted", d.lottery.uncounted_active_packs, fmtNumber)
                : tn("dash.ticketsSold", d.lottery.tickets_sold, fmtNumber)
            }
            tone={
              d.lottery.uncounted_active_packs > 0 ? "warning" : "positive"
            }
          />
        )}
        {d.purchases && (
          <KpiCard
            label={t("dash.purchases30")}
            value={fmtMoney2(d.purchases.d30)}
            sub={
              <AppLink to="/purchase-invoices" className="ds-link" style={{ color: tokens.accent }}>
                {d.purchases.open_count > 0
                  ? t("dash.openInvoices", {
                      count: fmtNumber(d.purchases.open_count),
                      total: fmtMoney2(d.purchases.open_total),
                    })
                  : t("dash.allInvoicesPaid")}
              </AppLink>
            }
            tone={d.purchases.open_count > 0 ? "warning" : "positive"}
          />
        )}
        <KpiCard
          label={t("dash.clockedInNow")}
          value={fmtNumber(d.clocked_in.length)}
          sub={
            <AppLink to="/admin/timeclock" className="ds-link" style={{ color: tokens.accent }}>
              {d.clocked_in.length > 0
                ? d.clocked_in.map((c) => c.name).slice(0, 3).join(", ")
                : t("dash.openTimeClock")}
            </AppLink>
          }
          tone={d.clocked_in.length > 0 ? "positive" : "neutral"}
        />
        <KpiCard
          label={t("dash.bankAccounts")}
          value={
            d.stripe_accounts.length > 0
              ? `Stripe · ${fmtNumber(d.stripe_accounts.length)}`
              : t("dash.notConnected")
          }
          sub={
            d.stripe_accounts.length > 0 ? (
              d.stripe_accounts[0].last_balance_as_of ? (
                t("dash.lastSync", { time: formatDateTime(d.stripe_accounts[0].last_balance_as_of) })
              ) : (
                "—"
              )
            ) : (
              <AppLink to="/bank" className="ds-link" style={{ color: tokens.accent }}>
                {t("dash.connectStripe")}
              </AppLink>
            )
          }
          tone={d.stripe_accounts.length > 0 ? "positive" : "neutral"}
        />
        {d.kpis.net_income_month != null && (
          <KpiCard
            label={t("dash.netIncome", { month })}
            value={fmtMoney(d.kpis.net_income_month)}
            sub={
              <AppLink to="/monthly" className="ds-link" style={{ color: tokens.accent }}>
                {t("dash.viewPL")}
              </AppLink>
            }
            tone={d.kpis.net_income_month >= 0 ? "positive" : "negative"}
          />
        )}
      </KpiGrid>

      {(d.sales || d.purchases) && (
        <Section title={t("dash.salesPurchases")}>
          <Card>
            <Table>
              <thead>
                <tr>
                  <th style={dashThStyle}>{t("dash.days")}</th>
                  {d.sales && <th style={dashThStyle}>{t("dash.sales")}</th>}
                  {d.purchases && <th style={dashThStyle}>{t("dash.purchases")}</th>}
                </tr>
              </thead>
              <tbody>
                {([
                  [t("dash.last24h"), d.sales?.today, d.purchases?.today],
                  [t("dash.nDays", { n: 7 }), d.sales?.d7, d.purchases?.d7],
                  [t("dash.nDays", { n: 15 }), d.sales?.d15, d.purchases?.d15],
                  [t("dash.nDays", { n: 30 }), d.sales?.d30, d.purchases?.d30],
                ] as Array<[string, number | undefined, number | undefined]>).map(
                  ([label, sales, purchases]) => (
                    <tr key={label}>
                      <td style={dashTdStyle}>{label}</td>
                      {d.sales && (
                        <td style={{ ...dashTdStyle, fontFamily: tokens.fontMono }}>
                          {fmtMoney2(sales ?? 0)}
                        </td>
                      )}
                      {d.purchases && (
                        <td style={{ ...dashTdStyle, fontFamily: tokens.fontMono }}>
                          {fmtMoney2(purchases ?? 0)}
                        </td>
                      )}
                    </tr>
                  ),
                )}
              </tbody>
            </Table>
          </Card>
        </Section>
      )}

      {d.sales && hasTrend && (
        <Section title={t("dash.dailySales14")}>
          <Card>
            <div style={{ height: "16rem" }}>
              <Line
                data={{
                  labels: d.sales.trend.map((p) => formatShortDate(p.date)),
                  datasets: [{
                    label: t("dash.salesDollars"),
                    data: d.sales.trend.map((p) => p.amount),
                    borderColor: chartSeries().accent,
                    backgroundColor: seriesFill("positive", 0.1),
                    fill: true,
                    tension: 0.25,
                    pointRadius: 0,
                  }],
                }}
                options={{
                  ...moneyChartOptions(t("dash.sales")),
                  maintainAspectRatio: false,
                }}
              />
            </div>
          </Card>
        </Section>
      )}

      {/* What the register did (D-4) — receipts, voids, refunds and
          fuel. Its own grid rather than more tiles in the one above:
          these are register facts, not the store's own ledger. */}
      <RegisterActivityTiles register={d.register} />

      {d.sales?.hourly && (
        <Section
          title={t("dash.hourlySales")}
          actions={
            <span style={{
              fontSize: fontSize.sm, color: tokens.textMuted,
              fontFamily: tokens.fontMono,
            }}>
              {d.sales.hourly.previous_total != null
                && `${t("dash.prevTotal", { amount: fmtMoney2(d.sales.hourly.previous_total) })} · `}
              {t("dash.currentTotal", { amount: fmtMoney2(d.sales.hourly.current_total) })}
            </span>
          }
        >
          <Card>
            <div style={{ height: "16rem" }}>
              <Line
                data={{
                  labels: Array.from({ length: 24 }, (_, h) => String(h)),
                  datasets: [
                    ...(d.sales.hourly.previous
                      ? [{
                          label: t("dash.previousOn", { date: formatShortDate(d.sales.hourly.previous_date ?? "") }),
                          data: d.sales.hourly.previous,
                          borderColor: chartSeries().neutral,
                          borderDash: [6, 4],
                          backgroundColor: "transparent",
                          fill: false,
                          tension: 0.25,
                          pointRadius: 0,
                        }]
                      : []),
                    {
                      label: t("dash.currentOn", { date: formatShortDate(d.sales.hourly.current_date) }),
                      data: d.sales.hourly.current,
                      borderColor: chartSeries().accent,
                      backgroundColor: seriesFill("positive", 0.12),
                      fill: true,
                      tension: 0.25,
                      pointRadius: 0,
                    },
                  ],
                }}
                options={{
                  ...moneyChartOptions(t("dash.sales")),
                  maintainAspectRatio: false,
                }}
              />
            </div>
          </Card>
        </Section>
      )}

      {d.clocked_in.length > 0 && (
        <Section
          title={t("dash.clockedInCount", { count: fmtNumber(d.clocked_in.length) })}
          actions={
            <ButtonLink to="/admin/timeclock" tone="secondary" size="sm">
              {t("dash.timeClock")}
            </ButtonLink>
          }
        >
          <Card>
            <div style={{ display: "flex", flexWrap: "wrap", gap: space.md }}>
              {d.clocked_in.map((c) => (
                <Pill key={`${c.name}-${c.clock_in_at}`} tone="accent">
                  {c.name}
                  {c.clock_in_at ? ` · ${t("dash.since", { time: formatTime(c.clock_in_at) })}` : ""}
                </Pill>
              ))}
            </div>
          </Card>
        </Section>
      )}

      {/* Sales / purchases / transfers over the same four windows,
          side by side (D-5). */}
      <PeriodRollup
        sales={d.sales}
        purchases={d.purchases}
        transfers={d.transfers_rollup}
      />

      <RecentReceipts receipts={d.recent_receipts} />

      {d.day_close && d.day_close.top_departments.length > 0 && (
        <Section title={t("dash.departmentSales", { date: formatShortDate(d.day_close.date) })}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: space.lg,
            }}
          >
            {d.day_close.top_departments.map((dept) => (
              <Card key={dept.name}>
                <div style={{ fontWeight: 600, marginBottom: space.sm }}>
                  {dept.name}
                </div>
                <div style={{ fontFamily: tokens.fontMono, fontSize: "1.4rem" }}>
                  {fmtMoney2(dept.amount)}
                </div>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {ms && (
      <Section title={t("dash.moneyServices")}>
        <KpiGrid>
          <KpiCard label={t("dash.totalTransfers")} value={fmtNumber(d.kpis.total_transfers)} sub={t("dash.allTime")} />
          <KpiCard
            label={t("dash.todayTransfers")}
            value={fmtNumber(d.kpis.today_transfers)}
            sub={formatShortDate(d.today)}
            tone="positive"
          />
          <KpiCard
            label={t("dash.unreconciledAch")}
            value={fmtNumber(d.kpis.pending_ach)}
            sub={d.kpis.pending_ach > 0 ? t("dash.needsAttention") : t("dash.allClear")}
            tone={d.kpis.pending_ach > 0 ? "negative" : "positive"}
          />
          <KpiCard
            label={t("dash.todayMsbBook")}
            value={d.kpis.today_report_entered ? t("dash.entered") : t("dash.pending")}
            sub={
              <AppLink
                to={`/daily/edit?date=${d.today}`}
                className="ds-link"
                style={{ color: tokens.accent }}
              >
                {d.kpis.today_report_entered ? t("dash.editReport") : t("dash.enterNow")}
              </AppLink>
            }
            tone={d.kpis.today_report_entered ? "positive" : "warning"}
          />
        </KpiGrid>
      </Section>
      )}

      {ms && (
      <Section title={t("dash.monthByCompany")}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: space.lg,
          }}
        >
          {d.company_stats.map((c) => (
            <Card key={c.company}>
              <header
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: space.md,
                }}
              >
                <span style={{ fontWeight: 600 }}>{c.company}</span>
                <Pill>{tn("transfer.count", c.count, fmtNumber)}</Pill>
              </header>
              <div style={{ fontFamily: tokens.fontMono, fontSize: "1.6rem" }}>
                {fmtMoney2(c.total)}
              </div>
              <div style={{ color: tokens.textMuted, fontSize: fontSize.sm }}>
                {t("dash.fees", { amount: fmtMoney2(c.fees) })}
              </div>
            </Card>
          ))}
          {d.company_stats.length === 0 && (
            <Card>
              <Empty>{t("dash.noCompanies")}</Empty>
            </Card>
          )}
        </div>
      </Section>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: space.lg,
        }}
      >
        {ms && (
        <Card>
          <header
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: space.md,
            }}
          >
            <span style={{ fontWeight: 600 }}>{t("dash.recentTransfers")}</span>
            <ButtonLink to="/transfers" tone="secondary" size="sm">{t("common.viewAll")}</ButtonLink>
          </header>
          <Table>
            <thead>
              <tr>
                {[
                  t("transfer.date"), t("transfer.sender"), t("transfer.company"),
                  t("dash.amount"), t("transfer.status"),
                ].map((h) => (
                  <th key={h} style={dashThStyle}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.recent_transfers.map((row) => (
                <tr key={row.id}>
                  <td style={dashTdStyle}>{formatShortDate(row.send_date)}</td>
                  <td style={dashTdStyle}>{row.sender_name}</td>
                  <td style={dashTdStyle}>{row.company}</td>
                  <td style={{ ...dashTdStyle, fontFamily: tokens.fontMono }}>
                    {fmtMoney2(row.send_amount)}
                  </td>
                  <td style={dashTdStyle}>
                    <StatusPill
                      value={row.status} text={statusLabel(row.status)}
                      tones={TRANSFER_STATUS_TONES}
                    />
                  </td>
                </tr>
              ))}
              {d.recent_transfers.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    style={{
                      ...dashTdStyle,
                      textAlign: "center",
                      color: tokens.textMuted,
                    }}
                  >
                    {t("dash.noTransfers")}
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
          {ms && (
          <Card>
            <header
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: space.md,
              }}
            >
              <span style={{ fontWeight: 600 }}>{t("dash.recentBatches")}</span>
              <ButtonLink to="/batches" tone="secondary" size="sm">{t("common.viewAll")}</ButtonLink>
            </header>
            <Table>
              <thead>
                <tr>
                  {[
                    t("transfer.date"), t("transfer.company"), t("batch.achAmount"),
                    t("batch.variance"), t("transfer.status"),
                  ].map((h) => (
                    <th key={h} style={dashThStyle}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.recent_batches.map((b) => (
                  <tr key={b.id}>
                    <td style={dashTdStyle}>{formatShortDate(b.ach_date)}</td>
                    <td style={dashTdStyle}>{b.company}</td>
                    <td style={{ ...dashTdStyle, fontFamily: tokens.fontMono }}>
                      {fmtMoney2(b.ach_amount)}
                    </td>
                    <td style={dashTdStyle}>
                      {fmtMoney2(b.variance)}
                    </td>
                    <td style={dashTdStyle}>
                      <StatusPill
                        value={b.status} text={batchStatusLabel(b.status)}
                        tones={BATCH_STATUS_TONES}
                      />
                    </td>
                  </tr>
                ))}
                {d.recent_batches.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      style={{
                        ...dashTdStyle,
                        textAlign: "center",
                        color: tokens.textMuted,
                      }}
                    >
                      {t("dash.noBatches")}
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Card>
          )}

          <Card>
            <header
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: space.md,
              }}
            >
              <span style={{ fontWeight: 600 }}>{t("dash.bankAccounts")}</span>
              <ButtonLink to="/bank" tone="secondary" size="sm">{t("common.viewAll")}</ButtonLink>
            </header>
            {d.stripe_accounts.length === 0 ? (
              <Empty>{t("dash.noBank")}</Empty>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                {d.stripe_accounts.map((a) => (
                  <div
                    key={a.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: `${space.sm} 0`,
                      borderBottom: `1px solid ${tokens.borderSubtle}`,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {a.display_name || t("dash.account")}
                        {a.last4 ? ` ••${a.last4}` : ""}
                      </div>
                      <div style={{ color: tokens.textMuted, fontSize: fontSize.sm }}>
                        {a.institution_name || "—"}
                      </div>
                    </div>
                    <div style={{ fontFamily: tokens.fontMono }}>
                      {fmtMoney2(a.last_balance)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

// ── Employee ──────────────────────────────────────────────────

function EmployeePanel({ d }: { d: EmployeeDashboard }) {
  const t = useT();
  const ms = d.modules.includes("module_money_services");
  return (
    <>
      <KpiGrid>
        {ms && (
          <KpiCard
            label={t("dash.todayTransfers")}
            value={fmtNumber(d.totals.count)}
            sub={formatShortDate(d.today)}
          />
        )}
        {d.day_close && (
          <KpiCard
            label={t("dash.storeSalesOn", { date: formatShortDate(d.day_close.date) })}
            value={fmtMoney2(d.day_close.gross_sales)}
            sub={
              <AppLink to="/store-book" className="ds-link" style={{ color: tokens.accent }}>
                {t("dash.openDailyBook")}
              </AppLink>
            }
          />
        )}
        {d.lottery && (
          <KpiCard
            label={t("dash.lotteryCounts")}
            value={
              d.lottery.uncounted_active_packs > 0
                ? t("dash.nPending", { count: fmtNumber(d.lottery.uncounted_active_packs) })
                : t("dash.done")
            }
            sub={
              <AppLink to="/lottery" className="ds-link" style={{ color: tokens.accent }}>
                {t("dash.countPacks")}
              </AppLink>
            }
            tone={
              d.lottery.uncounted_active_packs > 0 ? "warning" : "positive"
            }
          />
        )}
      </KpiGrid>

      {/* A cashier sees the register's own numbers too — the void
          count on their shift should not need a manager. */}
      <RegisterActivityTiles register={d.register} />

      {ms && (
      <Section
        title={t("dash.todayTransfers")}
        actions={
          <ButtonLink to="/transfers/new" tone="primary" size="sm">
            {t("transfer.newButton")}
          </ButtonLink>
        }
      >
        <Card>
          <Table>
            <thead>
              <tr>
                {[
                  t("dash.time"),
                  t("transfer.sender"),
                  t("transfer.company"),
                  t("dash.amount"),
                  t("transfer.fee"),
                  t("transfer.recipient"),
                  t("transfer.country"),
                  t("transfer.confirmNumber"),
                  t("transfer.status"),
                  "",
                ].map((h, i) => (
                  <th key={i} style={dashThStyle}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.today_transfers.map((row) => (
                <tr key={row.id}>
                  <td style={dashTdStyle}>
                    {row.created_at ? formatTime(row.created_at) : "—"}
                  </td>
                  <td style={dashTdStyle}>{row.sender_name}</td>
                  <td style={dashTdStyle}>{row.company}</td>
                  <td style={{ ...dashTdStyle, fontFamily: tokens.fontMono }}>
                    {fmtMoney2(row.send_amount)}{" "}
                    <TransferKindPill
                      serviceType={row.service_type}
                      paymentMethod={row.payment_method}
                    />
                  </td>
                  <td style={{ ...dashTdStyle, fontFamily: tokens.fontMono }}>
                    {fmtMoney2(row.fee)}
                  </td>
                  <td style={dashTdStyle}>{row.recipient_name || "—"}</td>
                  <td style={dashTdStyle}>{row.country || "—"}</td>
                  <td style={dashTdStyle}>{row.confirm_number || "—"}</td>
                  <td style={dashTdStyle}>
                    <StatusPill
                      value={row.status} text={statusLabel(row.status)}
                      tones={TRANSFER_STATUS_TONES}
                    />
                  </td>
                  <td style={dashTdStyle}>
                    <AppLink
                      to={`/transfers/${row.id}/edit`}
                      className="ds-link"
                      style={{ color: tokens.accent, fontSize: fontSize.sm }}
                    >
                      {t("transfer.edit")}
                    </AppLink>
                  </td>
                </tr>
              ))}
              {d.today_transfers.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    style={{
                      ...dashTdStyle,
                      textAlign: "center",
                      color: tokens.textMuted,
                      padding: `${space.xl} 0`,
                    }}
                  >
                    {t("dash.nothingToday")}
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      </Section>
      )}

      {ms && d.totals.count > 0 && (
        <Card>
          <div
            style={{
              display: "flex",
              gap: space["2xl"],
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <div>
              <span style={{ color: tokens.textMuted, fontSize: fontSize.sm }}>
                {t("dash.todayTotalSent")}
              </span>{" "}
              <strong style={{ fontFamily: tokens.fontMono }}>
                {fmtMoney2(d.totals.sent)}
              </strong>
            </div>
            {d.totals.paid_out > 0 && (
              <div>
                <span style={{ color: tokens.textMuted, fontSize: fontSize.sm }}>
                  {t("dash.paidOut")}
                </span>{" "}
                <strong style={{ fontFamily: tokens.fontMono }}>
                  {fmtMoney2(d.totals.paid_out)}
                </strong>
              </div>
            )}
            <div>
              <span style={{ color: tokens.textMuted, fontSize: fontSize.sm }}>
                {t("dash.feesCollected")}
              </span>{" "}
              <strong style={{ fontFamily: tokens.fontMono }}>
                {fmtMoney2(d.totals.fees)}
              </strong>
            </div>
            <div>
              <span style={{ color: tokens.textMuted, fontSize: fontSize.sm }}>
                {t("dash.transfersLabel")}
              </span>{" "}
              <strong>{fmtNumber(d.totals.count)}</strong>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────────

/** A stored status's pill: the tone comes from the stored (English)
 *  value, the words from its label in the person's language. */
function StatusPill({
  value, text, tones,
}: { value: string | null; text: string; tones: Record<string, PillTone> }) {
  return <Pill tone={(value && tones[value]) || "neutral"}>{text}</Pill>;
}

// Local table cell styles — extends the DS tokens with the dense
// table padding the dashboard tables use (sm vs md elsewhere).
const dashThStyle: React.CSSProperties = {
  textAlign: "left",
  padding: `${space.sm} ${space.md}`,
  borderBottom: `1px solid ${tokens.border}`,
  fontSize: fontSize.xs,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: tokens.textMuted,
  fontWeight: 500,
};

const dashTdStyle: React.CSSProperties = {
  padding: `${space.sm} ${space.md}`,
  borderBottom: `1px solid ${tokens.borderSubtle}`,
};
