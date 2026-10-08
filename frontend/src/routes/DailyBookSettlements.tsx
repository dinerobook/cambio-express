// Money that comes back — cash lent out of the drawer (an Other cash
// out ticked "Expected back") or borrowed into it (an Other cash in
// ticked "We pay this back"). The API keeps the books: the return is
// an ordinary entry of the opposite kind on the day the cash moved,
// linked to the original. See DailyBook/INVARIANTS.md "Settlements".
//
//   - <SettleFields>      the tick box + optional date on an entry
//   - <SettlementPill>    an entry's state in the entries table
//   - <SettlementsWidget> the "Owed to us" / "We owe" tile, its list
//                         and the Record return / Close actions

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  SETTLEMENT_PAIRS,
  createLineItem,
  updateLineItem,
  useOpenSettlements,
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
import styles from "./EditDailyBook.module.css";

/** The tick-box label for an entry of `kind`. */
function settleLabel(kind: string): string {
  return kind === "other_cash_in" ? "We pay this back" : "Expected back";
}

/** Tick box + optional "back by" date, for the add row and the
 *  inline edit of an Other cash out / Other cash in entry. */
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
        {item.kind === "other_cash_in" ? "Return" : "Payback"}
      </Pill>
    );
  }
  const left = item.amount - (item.settled ?? 0);
  if (item.expects_settlement) {
    if (left <= 0) return <Pill tone="accent">Settled</Pill>;
    return (
      <Pill tone="warning">
        {item.kind === "other_cash_in" ? "We owe" : "Expected back"}
        {" · "}{fmtMoney2(left)} left
      </Pill>
    );
  }
  if ((item.settled ?? 0) > 0) return <Pill tone="neutral">Closed</Pill>;
  return null;
}

type Direction = "owed_to_us" | "we_owe";

const DIRECTION: Record<Direction, {
  title: string; kind: string; record: string; settleKind: string;
}> = {
  // Lent out of the drawer → comes back as an Other cash in.
  owed_to_us: {
    title: "Owed to us", kind: "other_cash_out",
    record: "Record return", settleKind: "Other cash in",
  },
  // Borrowed into the drawer → paid back as an Other cash out.
  we_owe: {
    title: "We owe", kind: "other_cash_in",
    record: "Record payback", settleKind: "Other cash out",
  },
};

function isOverdue(o: OpenSettlement, today: string): boolean {
  return o.settle_by != null && o.settle_by < today;
}

/** Tile + list for one direction. `date` is the day being viewed:
 *  a return is booked there, so entries made after it are left out
 *  (a return can't predate what it settles). */
export function SettlementsWidget({
  direction, storeId, date, locked, onChange,
}: {
  direction: Direction;
  storeId: number;
  date: string;
  locked: boolean;
  onChange: () => void;
}) {
  const d = DIRECTION[direction];
  const query = useOpenSettlements();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState<OpenSettlement | null>(null);
  const [closing, setClosing] = useState<OpenSettlement | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeErr, setCloseErr] = useState<string | null>(null);

  const today = todayIso();
  const items = (query.data ?? []).filter(
    (o) => o.kind === d.kind && o.report_date <= date,
  );
  const total = items.reduce((s, o) => s + o.outstanding, 0);
  const overdue = items.filter((o) => isOverdue(o, today)).length;

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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={styles.widgetCard}
      >
        <span className={styles.widgetCardTop}>
          <span className={styles.widgetLabel}>{d.title}</span>
          <span className={styles.widgetTotal}>{fmtMoney2(total)}</span>
        </span>
        <span className={styles.widgetCount}>
          {items.length === 0 ? "Nothing open" : `${items.length} open`}
          {overdue > 0 && (
            <>{" · "}<Pill tone="negative">{overdue} overdue</Pill></>
          )}
        </span>
      </button>

      <Modal
        open={open}
        title={d.title}
        size="lg"
        onClose={() => setOpen(false)}
      >
        <div className={styles.lineModalBody}>
          {query.isError ? (
            <Alert tone="error">
              {apiErrorMessage(query.error, "Could not load open entries.")}
            </Alert>
          ) : items.length === 0 ? (
            <p className={styles.emptyEntries}>
              {direction === "owed_to_us"
                ? "Nothing is owed to the store. Tick \"Expected back\" on an Other cash out to track one."
                : "The store owes nothing. Tick \"We pay this back\" on an Other cash in to track one."}
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
            <p className={styles.emptyEntries}>
              This day is locked. Open an unlocked day to record a return.
            </p>
          )}
        </div>
      </Modal>

      {recording && (
        <RecordSettlementModal
          item={recording}
          title={d.record}
          settleKind={d.settleKind}
          storeId={storeId}
          date={date}
          onClose={() => setRecording(null)}
          onDone={() => { setRecording(null); refresh(); }}
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
  item, title, settleKind, storeId, date, onClose, onDone,
}: {
  item: OpenSettlement;
  title: string;
  settleKind: string;
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
        </p>
        {err && <Alert tone="error">{err}</Alert>}
      </div>
    </Modal>
  );
}
