import { useParams, useSearchParams } from "react-router-dom";

import { TIMECLOCK_STATUS_TONES, timeClockStatusLabel, usePaystub } from "../api/timeclock";
import { useStoreInfo } from "../api/account";
import { formatTimestamp } from "../lib/datetime";
import {
  Button, ErrorState, KpiCard, KpiGrid, Loading, PageShell, Pill,
} from "../components/ui";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { fmtHours, fmtMoney2 } from "../lib/formatters";
import styles from "./TimeClockPaystub.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { tNodes, useT } from "../i18n";

// /app/admin/timeclock/paystub/:id?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Printable paystub for one roster member. The page renders a
// clean letter-sized sheet (SPA chrome stripped via print CSS)
// summarising approved hours × hourly rate = gross pay, with
// every shift in the window itemised below for cross-check.

export default function TimeClockPaystub() {
  const { id } = useParams<{ id: string }>();
  const empId = id ? Number(id) : NaN;
  const [sp] = useSearchParams();
  const from = sp.get("from") ?? "";
  const to   = sp.get("to") ?? "";

  const identity = getCurrentIdentity();
  const { data: storeInfo } = useStoreInfo();
  const t = useT();

  const canView = identity?.role === "admin"
                  || identity?.role === "owner"
                  || identity?.role === "superadmin";

  const { data, isLoading, isError, error, refetch } = usePaystub(
    Number.isFinite(empId) ? empId : null, from, to, canView,
  );

  if (!canView) {
    return (
      <PageShell>
        <ErrorState message={t("payroll.adminOnly")} />
      </PageShell>
    );
  }

  if (!from || !to) {
    return (
      <PageShell>
        <ErrorState
          message={t("paystub.missingPeriod")}
        />
      </PageShell>
    );
  }

  if (isLoading) {
    return <PageShell><Loading /></PageShell>;
  }
  if (isError || !data) {
    return (
      <PageShell>
        <ErrorState
          message={apiErrorMessage(error, t("paystub.loadFailed"))}
          onRetry={() => { void refetch(); }}
        />
      </PageShell>
    );
  }

  const storeName = storeInfo?.store?.name ?? t("paystub.store");

  return (
    <PageShell maxWidth="48rem">
      <PageCrumbs current={t("paystub.title")} />
      <div className={styles.printbar}>
        <Button onClick={() => window.print()} tone="primary">
          {t("paystub.print")}
        </Button>
        <Button tone="secondary" onClick={() => window.history.back()}>
          {t("common.back")}
        </Button>
      </div>

      <div className={styles.paystub}>
        <div className={styles.header}>
          <div>
            <div className={styles.headerLeft}>{t("paystub.title")}</div>
            <div className={styles.headerSub}>
              {t("paystub.period", { store: storeName, from: data.from_date, to: data.to_date })}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontWeight: 600 }}>{data.employee_name}</div>
            <div className={styles.headerSub}>
              {t("paystub.rosterNumber", { id: data.store_employee_id })}
            </div>
          </div>
        </div>

        <div className={styles.summary}>
          <KpiGrid minWidth="12rem">
            <KpiCard
              label={t("payroll.approvedHours")}
              value={fmtHours(data.approved_hours)}
            />
            <KpiCard
              label={t("employee.hourlyRate")}
              value={data.hourly_rate > 0
                ? fmtMoney2(data.hourly_rate)
                : "—"}
            />
            <KpiCard
              label={t("paystub.grossPay")}
              tone="positive" colorValue
              value={data.hourly_rate > 0
                ? fmtMoney2(data.gross_pay)
                : "—"}
            />
          </KpiGrid>
        </div>

        <div className={styles.shiftsWrap}>
          <table className={styles.shifts}>
            <thead>
              <tr>
                <th>{t("payroll.timeIn")}</th>
              <th>{t("payroll.timeOut")}</th>
              <th>{t("paystub.hours")}</th>
              <th>{t("common.status")}</th>
              <th>{t("payroll.notes")}</th>
            </tr>
          </thead>
          <tbody>
            {data.shifts.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <em>{t("payroll.noShifts")}</em>
                </td>
              </tr>
            )}
            {data.shifts.map((s) => (
              <tr key={s.id}>
                <td className={styles.mono}>
                  {formatTimestamp(s.clock_in_at)}
                </td>
                <td className={styles.mono}>
                  {s.clock_out_at
                    ? formatTimestamp(s.clock_out_at)
                    : "—"}
                </td>
                <td className={styles.mono}>
                  {fmtHours(s.hours_worked)}
                </td>
                <td>
                  <Pill tone={TIMECLOCK_STATUS_TONES[s.status]}>{timeClockStatusLabel(s.status)}</Pill>
                </td>
                <td>{s.notes || "—"}</td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>

        <div className={styles.footer}>
          {tNodes("paystub.footer", {
            approved: <strong>{t("paystub.approved")}</strong>,
            when: formatTimestamp(new Date().toISOString()),
          })}
        </div>
      </div>
    </PageShell>
  );
}

