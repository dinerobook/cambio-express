// A customer's or a company's check history: totals for this store
// (and for all the owner's stores when there are several) and the
// latest checks, each with a manager's Void on the day it was cashed.
// Shown on both profiles and in the columns of Cash a check.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("Cash a check").

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  CHECK_STATUS_TONES, checkStatusLabel, useCheckActivity, voidCheck,
  type CashedCheckRow, type CheckStats,
} from "../api/checkCashing";
import {
  ConfirmDialog, Empty, ErrorState, Field, Input, KpiCard, KpiGrid, Loading,
  Modal, Pill, SectionTitle, Button, useToast,
} from "./ui";
import { PictureView } from "./CheckPictures";
import pictureStyles from "./CheckPictures.module.css";
import { useT } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { formatDate } from "../lib/datetime";
import { fmtMoney2 } from "../lib/formatters";
import styles from "../routes/CheckCashing.module.css";

export function CheckStatsGrid({ stats }: { stats: CheckStats }) {
  const t = useT();
  return (
    <>
      <KpiGrid minWidth="8.5rem">
        <KpiCard
          label={t("checkCashing.statCashed")}
          value={stats.count}
          sub={fmtMoney2(stats.total)}
        />
        <KpiCard label={t("checkCashing.statBiggest")} value={fmtMoney2(stats.biggest)} />
        <KpiCard label={t("checkCashing.statAverage")} value={fmtMoney2(stats.average)} />
        <KpiCard
          label={t("checkCashing.statLast")}
          value={stats.last_amount == null ? "—" : fmtMoney2(stats.last_amount)}
          sub={stats.last_day ? formatDate(stats.last_day) : undefined}
        />
      </KpiGrid>
      <p className={styles.note}>
        {t("checkCashing.statOther", { declined: stats.declined, voided: stats.voided })}
      </p>
    </>
  );
}

/** Totals + latest checks. `other` names the column the list shows:
 *  a customer's checks list their company, a company's their customer. */
export function CheckActivity({
  kind, id, other, compact = false,
}: {
  kind: "customers" | "companies";
  id: number;
  other: "customer" | "company";
  /** Cash a check's columns: totals in one line, the last 3 checks. */
  compact?: boolean;
}) {
  const t = useT();
  const activity = useCheckActivity(kind, id);

  if (activity.isError && !activity.data) {
    return (
      <ErrorState
        message={apiErrorMessage(activity.error, t("checkCashing.loadFailed"))}
        onRetry={() => void activity.refetch()}
        busy={activity.isFetching}
      />
    );
  }
  if (!activity.data) return <Loading />;

  const { stats, recent } = activity.data;
  const several = stats.length > 1;
  if (compact) {
    return (
      <>
        {stats.map((s) => (
          <p key={s.scope} className={styles.note}>
            {several && (
              <strong>
                {s.scope === "store" ? t("checkCashing.scopeStore") : t("checkCashing.scopeAll")}:{" "}
              </strong>
            )}
            {s.count === 0 ? t("checkCashing.statNone") : t("checkCashing.statLine", {
              count: s.count, total: fmtMoney2(s.total), biggest: fmtMoney2(s.biggest),
              date: s.last_day ? formatDate(s.last_day) : "—",
            })}
            {(s.declined > 0 || s.voided > 0) && ` · ${t("checkCashing.statOther", {
              declined: s.declined, voided: s.voided,
            })}`}
          </p>
        ))}
        {recent.length > 0 && <RecentChecks rows={recent.slice(0, 3)} other={other} />}
      </>
    );
  }
  return (
    <>
      {stats.map((s) => (
        <div key={s.scope}>
          {several && (
            <h4 className={styles.subhead}>
              {s.scope === "store" ? t("checkCashing.scopeStore") : t("checkCashing.scopeAll")}
            </h4>
          )}
          <CheckStatsGrid stats={s} />
        </div>
      ))}
      <SectionTitle>{t("checkCashing.recentChecks")}</SectionTitle>
      <RecentChecks rows={recent} other={other} />
    </>
  );
}

export function RecentChecks({
  rows, other,
}: {
  rows: CashedCheckRow[];
  other: "customer" | "company";
}) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [voiding, setVoiding] = useState<CashedCheckRow | null>(null);
  const [viewing, setViewing] = useState<CashedCheckRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmVoid() {
    if (!voiding) return;
    setBusy(true); setError(null);
    try {
      await voidCheck(voiding.id, reason.trim());
      await queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
      toast({ message: t("checkCashing.voided"), tone: "success" });
      setVoiding(null);
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.voidFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (rows.length === 0) return <Empty>{t("checkCashing.noChecks")}</Empty>;

  return (
    <>
      {rows.map((row) => (
        <div key={row.id} className={styles.idRow}>
          <div className={styles.idText}>
            <span className={styles.statusCell}>
              <strong>{fmtMoney2(row.amount)}</strong>
              <Pill tone={CHECK_STATUS_TONES[row.status] ?? "neutral"}>
                {checkStatusLabel(row.status)}
              </Pill>
              {row.approved && <Pill tone="info">{t("checkCashing.approvedPill")}</Pill>}
            </span>
            <span className={styles.name}>
              {other === "company" ? row.company_name : row.customer_name}
              {row.check_number && ` · #${row.check_number}`}
            </span>
            <span className={styles.muted}>
              {[
                formatDate(row.store_day),
                row.store_name,
                row.status === "cashed"
                  ? t("checkCashing.feeAndCash", {
                    fee: fmtMoney2(row.fee), cash: fmtMoney2(row.cash),
                  })
                  : row.status === "declined" ? row.reason : row.void_reason,
              ].filter(Boolean).join(" · ")}
            </span>
          </div>
          {(row.can_void || row.front_picture_id != null || row.back_picture_id != null) && (
            <div className={styles.idActions}>
              {(row.front_picture_id != null || row.back_picture_id != null) && (
                <Button type="button" tone="ghost" size="sm" onClick={() => setViewing(row)}>
                  {t("checkCashing.pictures")}
                </Button>
              )}
              {row.can_void && (
                <Button
                  type="button" tone="ghost" size="sm"
                  onClick={() => { setReason(""); setError(null); setVoiding(row); }}
                >
                  {t("checkCashing.void")}
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
      <Modal
        open={viewing != null} onClose={() => setViewing(null)} size="lg"
        title={viewing ? t("checkCashing.picturesOf", {
          amount: fmtMoney2(viewing.amount), name: viewing.company_name,
        }) : ""}
        actions={(
          <Button type="button" tone="secondary" onClick={() => setViewing(null)}>
            {t("common.close")}
          </Button>
        )}
      >
        {viewing && (
          <div className={pictureStyles.stack}>
            {viewing.front_picture_id != null && (
              <PictureView id={viewing.front_picture_id} label={t("checkCashing.checkFront")} size="large" />
            )}
            {viewing.back_picture_id != null && (
              <PictureView id={viewing.back_picture_id} label={t("checkCashing.checkBack")} size="large" />
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={voiding != null}
        title={t("checkCashing.voidTitle")}
        message={voiding ? (
          <>
            <p className={styles.note}>
              {t("checkCashing.voidMessage", {
                amount: fmtMoney2(voiding.amount), name: voiding.customer_name,
              })}
            </p>
            <Field label={t("checkCashing.voidReason")}>
              <Input
                type="text" maxLength={255} autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </>
        ) : ""}
        confirmLabel={t("checkCashing.void")}
        confirmTone="danger"
        busy={busy}
        error={error}
        onConfirm={() => {
          if (!reason.trim()) { setError(t("checkCashing.voidNeedsReason")); return; }
          void confirmVoid();
        }}
        onCancel={() => { setVoiding(null); setError(null); }}
      />
    </>
  );
}
