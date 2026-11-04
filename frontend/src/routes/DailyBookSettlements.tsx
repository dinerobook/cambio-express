// Money that comes back — cash lent out of the drawer (a Cash Out
// entry ticked "Expected back") or borrowed into it (a Cash In
// ticked "We pay this back"). The API keeps the books: the return is
// an ordinary entry of the opposite kind on the day the cash moved,
// linked to the original. See DailyBook/INVARIANTS.md "Settlements".
//
// Held checks ride the same machinery: a check on hold is always
// open, and Deposit on the Check Deposits box's On hold tab books a
// linked held-check deposit on the day the checks reach the bank — an
// entry that moves no cash (INVARIANTS.md "Held checks").
//
//   - <SettleFields>      the tick box + optional date on an entry
//   - <SettlementPill>    an entry's state in the entries table
//   - <CashFlowWidget>    the Cash In / Cash Out box: today's entries
//                         and, on a second tab, the money still owed
//   - <SettlementsList>   the open entries with the Record return /
//                         Change date / Close actions. A locked day is
//                         view only: none of them on a locked day, and
//                         no Change date / Close on an entry whose own
//                         day is locked (its return still books on the
//                         unlocked day the money moves)

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  SETTLEMENT_PAIRS,
  createLineItem,
  isAlwaysOpen,
  updateLineItem,
  type LineItemRow,
  type OpenSettlement,
} from "../api/dailybook";
import { apiErrorMessage } from "../lib/api";
import { fmtMoney2 } from "../lib/formatters";
import { formatDate, todayIso } from "../lib/datetime";
import {
  Alert, Button, Checkbox, ConfirmDialog, DateInput, Field, Input, Modal,
  MoneyInput, Pill, RowActions,
} from "../components/ui";
import { isOverdue, useOpenOfKind } from "./dailyBookOpen";
import { BoxTabs, DailyBookTile, OpenStatusPill } from "./DailyBookTile";
import styles from "./EditDailyBook.module.css";
import { t, useT, type MessageKey } from "../i18n";

/** The tick-box label for an entry of `kind`. */
function settleLabel(kind: string): string {
  return t(kind === "other_cash_in" ? "daily.wePayBack" : "daily.expectedBack");
}

/** Tick box + optional "back by" date, for the add row and the
 *  inline edit of a Cash Out / Cash In entry. A check on hold
 *  is always open, so it gets the date alone. */
export function SettleFields({
  kind, checked, onCheckedChange, settleBy, onSettleByChange, disabled,
}: {
  kind: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  settleBy: string;
  onSettleByChange: (next: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  if (isAlwaysOpen(kind)) {
    if (!checked) return null;
    return (
      <div className={styles.settleFields}>
        <Field label={t("daily.depositByOptional")}>
          <DateInput
            value={settleBy}
            onChange={(e) => onSettleByChange(e.target.value)}
            disabled={disabled}
            aria-label={t("daily.depositBy")}
          />
        </Field>
      </div>
    );
  }
  return (
    <div className={styles.settleFields}>
      <Checkbox
        checked={checked}
        onChange={onCheckedChange}
        disabled={disabled}
      >
        {settleLabel(kind)}
      </Checkbox>
      {checked && (
        <Field label={t("daily.byOptional")}>
          <DateInput
            value={settleBy}
            onChange={(e) => onSettleByChange(e.target.value)}
            disabled={disabled}
            aria-label={t("daily.settleBy")}
          />
        </Field>
      )}
    </div>
  );
}

/** One entry's settlement state, or nothing for a plain entry. */
export function SettlementPill({ item }: { item: LineItemRow }) {
  const t = useT();
  if (item.settles_item_id != null) {
    return (
      <Pill tone="info">
        {t(item.kind === "other_cash_in" ? "daily.pillReturn"
          : item.kind === "held_check_deposit" ? "daily.pillDeposited" : "daily.pillPayback")}
      </Pill>
    );
  }
  const left = item.amount - (item.settled ?? 0);
  const hold = item.kind === "check_hold";
  if (item.expects_settlement) {
    if (left <= 0) {
      return <Pill tone="accent">{t(hold ? "daily.pillDeposited" : "daily.pillSettled")}</Pill>;
    }
    return (
      <Pill tone="warning">
        {t(hold ? "daily.pillOnHand" : item.kind === "other_cash_in" ? "daily.weOwe" : "daily.expectedBack")}
        {" · "}{t(hold ? "daily.toDeposit" : "daily.left", { amount: fmtMoney2(left) })}
      </Pill>
    );
  }
  if ((item.settled ?? 0) > 0) return <Pill tone="neutral">{t("daily.pillClosed")}</Pill>;
  return null;
}

type Direction = "owed_to_us" | "we_owe" | "checks_on_hand";

// Every word here is a translator key (i18n/en.ts), read with t().
const DIRECTION: Record<Direction, {
  kind: string; record: MessageKey; settleKind: MessageKey;
  empty: MessageKey; lockedHint: MessageKey; cashNote?: MessageKey;
}> = {
  // Lent out of the drawer → comes back as a Cash In entry.
  owed_to_us: {
    kind: "other_cash_out",
    record: "daily.recordReturn", settleKind: "daily.cashIn",
    empty: "daily.owedToUsEmpty",
    lockedHint: "daily.owedToUsLocked",
  },
  // Borrowed into the drawer → paid back as a Cash Out entry.
  we_owe: {
    kind: "other_cash_in",
    record: "daily.recordPayback", settleKind: "daily.cashOut",
    empty: "daily.weOweEmpty",
    lockedHint: "daily.weOweLocked",
  },
  // Checks cashed and kept → deposited on a later day. The deposit
  // moves no cash: it left the drawer on the day of the hold.
  checks_on_hand: {
    kind: "check_hold",
    record: "daily.deposit", settleKind: "daily.checkDepositsFromHold",
    empty: "daily.checksOnHandEmpty",
    lockedHint: "daily.checksOnHandLocked",
    cashNote: "daily.checksOnHandCashNote",
  },
};

// Cash In / Cash Out — one tile, one modal, two tabs:
//   - Received / Paid out: today's entries of the kind (other_cash_in
//     / other_cash_out), with the "We pay this back" / "Expected back"
//     tick box on each.
//   - Owed to us / We owe: what is still open from ANY day up to this
//     one (SettlementsList — Record return / payback, Change date,
//     Close). It is shown on the box the money comes back through:
//     cash lent out returns as Cash In, a loan is repaid as Cash Out.
// The tile's total is today's entries only; the open amount is an
// outlined pill because it is not in today's total.
// INVARIANTS.md "Settlements".
const CASH_FLOW = {
  in: {
    title: "daily.cashIn",
    todayLabel: "daily.received", todayPart: "daily.receivedToday",
    openLabel: "daily.owedToUs", settlement: "owed_to_us",
    todayTip: "daily.cashInTodayTip",
    openTip: "daily.cashInOpenTip",
    aboutToday: "daily.aboutReceived", aboutOpen: "daily.aboutOwedToUs",
  },
  out: {
    title: "daily.cashOut",
    todayLabel: "daily.paidOut", todayPart: "daily.paidOutToday",
    openLabel: "daily.weOwe", settlement: "we_owe",
    todayTip: "daily.cashOutTodayTip",
    openTip: "daily.cashOutOpenTip",
    aboutToday: "daily.aboutPaidOut", aboutOpen: "daily.aboutWeOwe",
  },
} as const satisfies Record<string, {
  title: MessageKey; todayLabel: MessageKey; todayPart: MessageKey;
  openLabel: MessageKey; settlement: Direction; todayTip: MessageKey;
  openTip: MessageKey; aboutToday: MessageKey; aboutOpen: MessageKey;
}>;

export function CashFlowWidget({
  direction, total, entries, storeId, date, locked, onChange,
}: {
  direction: keyof typeof CASH_FLOW;
  /** Today's total of the kind (other_cash_in / other_cash_out). */
  total: number;
  /** The Received / Paid out tab: today's entries editor. */
  entries: ReactNode;
  storeId: number;
  date: string;
  locked: boolean;
  onChange: () => void;
}) {
  const t = useT();
  const c = CASH_FLOW[direction];
  const owed = useOpenOfKind(
    direction === "in" ? "other_cash_out" : "other_cash_in", date,
  );
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"today" | "open">("today");

  return (
    <>
      <DailyBookTile
        title={t(c.title)}
        total={total}
        parts={[
          { label: t(c.todayPart), amount: total },
          { label: t(c.openLabel), amount: owed.total, open: true },
        ]}
        status={
          <OpenStatusPill open={owed.items.length} overdue={owed.overdue} />
        }
        onOpen={() => setOpen(true)}
      />

      <Modal
        open={open}
        title={t(c.title)}
        size="lg"
        onClose={() => setOpen(false)}
      >
        <div className={styles.lineModalBody}>
          <BoxTabs
            tabs={[
              { key: "today", label: t(c.todayLabel), amount: total },
              {
                key: "open", label: t(c.openLabel), amount: owed.total,
                status: <OpenStatusPill open={0} overdue={owed.overdue} />,
              },
            ]}
            active={tab}
            onChange={setTab}
            tip={t(tab === "today" ? c.todayTip : c.openTip)}
            tipLabel={t(tab === "today" ? c.aboutToday : c.aboutOpen)}
          />
          {tab === "today" ? entries : (
            <SettlementsList
              direction={c.settlement}
              storeId={storeId}
              date={date}
              locked={locked}
              onChange={onChange}
            />
          )}
        </div>
      </Modal>
    </>
  );
}

/** The open entries of one direction with their Record / Change date
 *  / Close actions — the Owed to us tab of the Cash In box, the We owe
 *  tab of the Cash Out box, and the On hold tab of the Check Deposits
 *  box. */
export function SettlementsList({
  direction, storeId, date, locked, onChange,
}: {
  direction: Direction;
  storeId: number;
  date: string;
  locked: boolean;
  onChange: () => void;
}) {
  const t = useT();
  const d = DIRECTION[direction];
  const { query, items } = useOpenOfKind(DIRECTION[direction].kind, date);
  const queryClient = useQueryClient();
  const [recording, setRecording] = useState<OpenSettlement | null>(null);
  const [redating, setRedating] = useState<OpenSettlement | null>(null);
  const [closing, setClosing] = useState<OpenSettlement | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeErr, setCloseErr] = useState<string | null>(null);

  const today = todayIso();

  function refresh() {
    void queryClient.invalidateQueries({
      queryKey: ["dailybook", "settlements", storeId],
    });
    onChange();
  }

  async function confirmClose() {
    if (!closing) return;
    setCloseBusy(true);
    setCloseErr(null);
    try {
      await updateLineItem(storeId, closing.id, { expects_settlement: false });
      setClosing(null);
      refresh();
    } catch (e) {
      setCloseErr(apiErrorMessage(e, t("daily.closeFailed")));
    } finally {
      setCloseBusy(false);
    }
  }

  return (
    <>
      <div className={styles.lineModalBody}>
        {query.isError ? (
          <Alert tone="error">
            {apiErrorMessage(query.error, t("daily.openLoadFailed"))}
          </Alert>
        ) : items.length === 0 ? (
          <p className={styles.emptyEntries}>
            {t(d.empty)}
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className={styles.widgetTable}>
              <thead>
                <tr>
                  <th className={styles.widgetTh}>{t("daily.whoNote")}</th>
                  <th className={styles.widgetTh}>{t("daily.day")}</th>
                  <th className={styles.widgetTh}>{t("daily.amount")}</th>
                  <th className={styles.widgetTh}>{t("daily.leftColumn")}</th>
                  <th className={styles.widgetTh}>{t("daily.byColumn")}</th>
                  <th className={styles.widgetTh} aria-label={t("daily.actionsColumn")} />
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td className={styles.widgetTd}>
                      {o.note || "—"}
                      {o.returns.map((r) => (
                        <div key={r.id} className={styles.widgetTdSmall}>
                          {t("daily.amountOnDate", { amount: fmtMoney2(r.amount), date: formatDate(r.report_date) })}
                        </div>
                      ))}
                    </td>
                    <td className={styles.widgetTdMono}>
                      {formatDate(o.report_date)}
                    </td>
                    <td className={styles.widgetTdMono}>{fmtMoney2(o.amount)}</td>
                    <td className={styles.widgetTdMono}>
                      {fmtMoney2(o.outstanding)}
                    </td>
                    <td className={styles.widgetTd}>
                      {o.settle_by == null ? (
                        <Pill tone="neutral">{t("daily.noDate")}</Pill>
                      ) : isOverdue(o, today) ? (
                        <Pill tone="negative">
                          {t("daily.dateOverdue", { date: formatDate(o.settle_by) })}
                        </Pill>
                      ) : (
                        <Pill tone="warning">{formatDate(o.settle_by)}</Pill>
                      )}
                    </td>
                    <td className={styles.widgetTd}>
                      <RowActions
                        label={t("daily.actions")}
                        actions={[
                          {
                            label: t(d.record),
                            tone: "primary",
                            perm: "daily_book.create",
                            hidden: locked,
                            onClick: () => setRecording(o),
                          },
                          {
                            label: t("daily.changeDate"),
                            perm: "daily_book.update",
                            hidden: locked || o.day_locked,
                            onClick: () => setRedating(o),
                          },
                          {
                            label: t("daily.close"),
                            perm: "daily_book.update",
                            hidden: locked || o.day_locked,
                            onClick: () => { setCloseErr(null); setClosing(o); },
                          },
                        ]}
                      />
                      {!locked && o.day_locked && (
                        <div className={styles.widgetTdSmall}>
                          {t("daily.entryDayLocked", { date: formatDate(o.report_date) })}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {locked && items.length > 0 && (
          <p className={styles.emptyEntries}>{t(d.lockedHint)}</p>
        )}
      </div>

      {recording && (
        <RecordSettlementModal
          item={recording}
          title={t(d.record)}
          settleKind={t(d.settleKind)}
          cashNote={d.cashNote ? t(d.cashNote) : undefined}
          storeId={storeId}
          date={date}
          onClose={() => setRecording(null)}
          onDone={() => { setRecording(null); refresh(); }}
        />
      )}

      {redating && (
        <SettleByModal
          item={redating}
          storeId={storeId}
          onClose={() => setRedating(null)}
          onDone={() => { setRedating(null); refresh(); }}
        />
      )}

      <ConfirmDialog
        open={closing != null}
        title={t("daily.closeTitle")}
        message={closing
          ? t("daily.closeMessage", {
            amount: fmtMoney2(closing.outstanding),
            what: closing.note || t("daily.thisEntryLower"),
          })
          : ""}
        confirmLabel={t("daily.close")}
        busy={closeBusy}
        error={closeErr}
        onConfirm={() => { void confirmClose(); }}
        onCancel={() => setClosing(null)}
      />
    </>
  );
}

function RecordSettlementModal({
  item, title, settleKind, cashNote, storeId, date, onClose, onDone,
}: {
  item: OpenSettlement;
  title: string;
  settleKind: string;
  cashNote?: string;
  storeId: number;
  date: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [amount, setAmount] = useState(item.outstanding);
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    if (!amount || amount <= 0) {
      setErr(t("daily.amountPositive"));
      return;
    }
    if (amount > item.outstanding) {
      setErr(t("daily.onlyOutstanding", { amount: fmtMoney2(item.outstanding) }));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await createLineItem(storeId, date, {
        kind: SETTLEMENT_PAIRS[item.kind],
        at_time: time,
        amount,
        note: item.note,
        settles_item_id: item.id,
      });
      onDone();
    } catch (e) {
      setErr(apiErrorMessage(e, t("daily.recordFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={title}
      size="sm"
      onClose={onClose}
      disabled={busy}
      actions={(
        <>
          <Button type="button" tone="secondary" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button" tone="primary" busy={busy}
            onClick={() => { void save(); }}
          >
            {title}
          </Button>
        </>
      )}
    >
      <div className={styles.lineModalBody}>
        <p style={{ margin: 0 }}>
          {t("daily.entryLeft", { what: item.note || t("daily.thisEntry"), amount: fmtMoney2(item.outstanding) })}
        </p>
        <MoneyInput label={t("daily.amount")} value={amount} onChange={setAmount} disabled={busy} />
        <Field label={t("daily.timeOptional")}>
          <Input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={busy}
          />
        </Field>
        <p className={styles.widgetTdSmall} style={{ margin: 0 }}>
          {t("daily.addsTo", { amount: fmtMoney2(amount || 0), box: settleKind, date: formatDate(date) })}
          {cashNote && <>{" "}{cashNote}</>}
        </p>
        {err && <Alert tone="error">{err}</Alert>}
      </div>
    </Modal>
  );
}

function SettleByModal({
  item, storeId, onClose, onDone,
}: {
  item: OpenSettlement;
  storeId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [settleBy, setSettleBy] = useState(item.settle_by ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await updateLineItem(storeId, item.id, { settle_by: settleBy || null });
      onDone();
    } catch (e) {
      setErr(apiErrorMessage(e, t("daily.changeDateFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("daily.changeDate")}
      size="sm"
      onClose={onClose}
      disabled={busy}
      actions={(
        <>
          <Button type="button" tone="secondary" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button" tone="primary" busy={busy}
            onClick={() => { void save(); }}
          >
            {t("daily.saveShort")}
          </Button>
        </>
      )}
    >
      <div className={styles.lineModalBody}>
        <p style={{ margin: 0 }}>
          {t("daily.entryLeft", { what: item.note || t("daily.thisEntry"), amount: fmtMoney2(item.outstanding) })}
        </p>
        <Field label={t("daily.byLeaveEmpty")}>
          <DateInput
            value={settleBy}
            onChange={(e) => setSettleBy(e.target.value)}
            disabled={busy}
            aria-label={t("daily.settleBy")}
          />
        </Field>
        {err && <Alert tone="error">{err}</Alert>}
      </div>
    </Modal>
  );
}
