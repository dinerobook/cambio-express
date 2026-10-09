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
//                         Change date / Close actions (the last two
//                         also work when the entry's own day is
//                         locked — they move no money)

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

/** The tick-box label for an entry of `kind`. */
function settleLabel(kind: string): string {
  return kind === "other_cash_in" ? "We pay this back" : "Expected back";
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
  if (isAlwaysOpen(kind)) {
    if (!checked) return null;
    return (
      <div className={styles.settleFields}>
        <Field label="Deposit by (optional)">
          <DateInput
            value={settleBy}
            onChange={(e) => onSettleByChange(e.target.value)}
            disabled={disabled}
            aria-label="Deposit by"
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
        <Field label="By (optional)">
          <DateInput
            value={settleBy}
            onChange={(e) => onSettleByChange(e.target.value)}
            disabled={disabled}
            aria-label="Settle by"
          />
        </Field>
      )}
    </div>
  );
}

/** One entry's settlement state, or nothing for a plain entry. */
export function SettlementPill({ item }: { item: LineItemRow }) {
  if (item.settles_item_id != null) {
    return (
      <Pill tone="info">
        {item.kind === "other_cash_in" ? "Return"
          : item.kind === "held_check_deposit" ? "Deposited" : "Payback"}
      </Pill>
    );
  }
  const left = item.amount - (item.settled ?? 0);
  const hold = item.kind === "check_hold";
  if (item.expects_settlement) {
    if (left <= 0) {
      return <Pill tone="accent">{hold ? "Deposited" : "Settled"}</Pill>;
    }
    return (
      <Pill tone="warning">
        {hold ? "On hand" : item.kind === "other_cash_in" ? "We owe" : "Expected back"}
        {" · "}{fmtMoney2(left)} {hold ? "to deposit" : "left"}
      </Pill>
    );
  }
  if ((item.settled ?? 0) > 0) return <Pill tone="neutral">Closed</Pill>;
  return null;
}

type Direction = "owed_to_us" | "we_owe" | "checks_on_hand";

const DIRECTION: Record<Direction, {
  kind: string; record: string; settleKind: string;
  empty: string; lockedHint: string; cashNote?: string;
}> = {
  // Lent out of the drawer → comes back as a Cash In entry.
  owed_to_us: {
    kind: "other_cash_out",
    record: "Record return", settleKind: "Cash In",
    empty: "Nothing is owed to the store. Tick \"Expected back\" on a Cash Out entry to track one.",
    lockedHint: "This day is locked. Open an unlocked day to record a return.",
  },
  // Borrowed into the drawer → paid back as a Cash Out entry.
  we_owe: {
    kind: "other_cash_in",
    record: "Record payback", settleKind: "Cash Out",
    empty: "The store owes nothing. Tick \"We pay this back\" on a Cash In entry to track one.",
    lockedHint: "This day is locked. Open an unlocked day to record a payback.",
  },
  // Checks cashed and kept → deposited on a later day. The deposit
  // moves no cash: it left the drawer on the day of the hold.
  checks_on_hand: {
    kind: "check_hold",
    record: "Deposit", settleKind: "Check Deposits (from hold)",
    empty: "No checks on hand. Add one below when you cash a check to deposit later.",
    lockedHint: "This day is locked. Open the day you go to the bank to record a deposit.",
    cashNote: "No effect on cash or over/short: the cash left the drawer on the day the checks were held.",
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
    title: "Cash In",
    todayLabel: "Received", todayPart: "Received today",
    openLabel: "Owed to us", settlement: "owed_to_us",
    todayTip: "Cash put into the drawer today. Tick \"We pay this back\" on a loan to track it under We owe on the Cash Out box.",
    openTip: "Cash lent out of the drawer (a Cash Out ticked \"Expected back\"). Record return books it here, as Cash In, on this day.",
  },
  out: {
    title: "Cash Out",
    todayLabel: "Paid out", todayPart: "Paid out today",
    openLabel: "We owe", settlement: "we_owe",
    todayTip: "Cash taken out of the drawer today. Tick \"Expected back\" on cash lent out to track it under Owed to us on the Cash In box.",
    openTip: "Cash borrowed into the drawer (a Cash In ticked \"We pay this back\"). Record payback books it here, as Cash Out, on this day.",
  },
} as const;

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
  const c = CASH_FLOW[direction];
  const owed = useOpenOfKind(
    direction === "in" ? "other_cash_out" : "other_cash_in", date,
  );
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"today" | "open">("today");

  return (
    <>
      <DailyBookTile
        title={c.title}
        total={total}
        parts={[
          { label: c.todayPart, amount: total },
          { label: c.openLabel, amount: owed.total, open: true },
        ]}
        status={
          <OpenStatusPill open={owed.items.length} overdue={owed.overdue} />
        }
        onOpen={() => setOpen(true)}
      />

      <Modal
        open={open}
        title={c.title}
        size="lg"
        onClose={() => setOpen(false)}
      >
        <div className={styles.lineModalBody}>
          <BoxTabs
            tabs={[
              { key: "today", label: c.todayLabel, amount: total },
              {
                key: "open", label: c.openLabel, amount: owed.total,
                status: <OpenStatusPill open={0} overdue={owed.overdue} />,
              },
            ]}
            active={tab}
            onChange={setTab}
            tip={tab === "today" ? c.todayTip : c.openTip}
            tipLabel={`About ${tab === "today" ? c.todayLabel : c.openLabel}`.toLowerCase()}
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
      setCloseErr(apiErrorMessage(e, "Could not close this entry."));
    } finally {
      setCloseBusy(false);
    }
  }

  return (
    <>
      <div className={styles.lineModalBody}>
        {query.isError ? (
          <Alert tone="error">
            {apiErrorMessage(query.error, "Could not load open entries.")}
          </Alert>
        ) : items.length === 0 ? (
          <p className={styles.emptyEntries}>
            {d.empty}
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className={styles.widgetTable}>
              <thead>
                <tr>
                  <th className={styles.widgetTh}>Who / note</th>
                  <th className={styles.widgetTh}>Day</th>
                  <th className={styles.widgetTh}>Amount</th>
                  <th className={styles.widgetTh}>Left</th>
                  <th className={styles.widgetTh}>By</th>
                  <th className={styles.widgetTh} aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td className={styles.widgetTd}>
                      {o.note || "—"}
                      {o.returns.map((r) => (
                        <div key={r.id} className={styles.widgetTdSmall}>
                          {fmtMoney2(r.amount)} on {formatDate(r.report_date)}
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
                        <Pill tone="neutral">No date</Pill>
                      ) : isOverdue(o, today) ? (
                        <Pill tone="negative">
                          {formatDate(o.settle_by)} · overdue
                        </Pill>
                      ) : (
                        <Pill tone="warning">{formatDate(o.settle_by)}</Pill>
                      )}
                    </td>
                    <td className={styles.widgetTd}>
                      <RowActions
                        label="Actions"
                        actions={[
                          {
                            label: d.record,
                            tone: "primary",
                            perm: "daily_book.create",
                            hidden: locked,
                            onClick: () => setRecording(o),
                          },
                          {
                            label: "Change date",
                            perm: "daily_book.update",
                            onClick: () => setRedating(o),
                          },
                          {
                            label: "Close",
                            perm: "daily_book.update",
                            onClick: () => { setCloseErr(null); setClosing(o); },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {locked && items.length > 0 && (
          <p className={styles.emptyEntries}>{d.lockedHint}</p>
        )}
      </div>

      {recording && (
        <RecordSettlementModal
          item={recording}
          title={d.record}
          settleKind={d.settleKind}
          cashNote={d.cashNote}
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
        title="Close this entry?"
        message={closing ? (
          <>
            {fmtMoney2(closing.outstanding)} of “{closing.note || "this entry"}”
            stops showing as open. Nothing already booked changes.
          </>
        ) : ""}
        confirmLabel="Close"
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
  const [amount, setAmount] = useState(item.outstanding);
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    if (!amount || amount <= 0) {
      setErr("Amount must be greater than zero.");
      return;
    }
    if (amount > item.outstanding) {
      setErr(`Only ${fmtMoney2(item.outstanding)} is still outstanding.`);
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
      setErr(apiErrorMessage(e, "Could not record this."));
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
            Cancel
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
          {item.note || "This entry"} · {fmtMoney2(item.outstanding)} left
        </p>
        <MoneyInput label="Amount" value={amount} onChange={setAmount} disabled={busy} />
        <Field label="Time (optional)">
          <Input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={busy}
          />
        </Field>
        <p className={styles.widgetTdSmall} style={{ margin: 0 }}>
          Adds {fmtMoney2(amount || 0)} to {settleKind} on {formatDate(date)}.
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
      setErr(apiErrorMessage(e, "Could not change the date."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="Change date"
      size="sm"
      onClose={onClose}
      disabled={busy}
      actions={(
        <>
          <Button type="button" tone="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button" tone="primary" busy={busy}
            onClick={() => { void save(); }}
          >
            Save
          </Button>
        </>
      )}
    >
      <div className={styles.lineModalBody}>
        <p style={{ margin: 0 }}>
          {item.note || "This entry"} · {fmtMoney2(item.outstanding)} left
        </p>
        <Field label="By (leave empty for no date)">
          <DateInput
            value={settleBy}
            onChange={(e) => setSettleBy(e.target.value)}
            disabled={busy}
            aria-label="Settle by"
          />
        </Field>
        {err && <Alert tone="error">{err}</Alert>}
      </div>
    </Modal>
  );
}
