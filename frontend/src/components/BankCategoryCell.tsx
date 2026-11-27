import { useState, type ReactNode } from "react";

import {
  categorizeTransaction,
  dailyTwinsFromError,
  lockedDayFromError,
  matchTransaction,
  uncategorizeTransaction,
  type BankCategoryGroup,
  type BankTransactionRow,
  type DailyTwin,
} from "../api/bankSync";
import { BankCategoryOptions } from "./BankCategoryOptions";
import { AppLink, Button, DateInput, Select, useToast } from "./ui";
import { apiErrorMessage } from "../lib/api";
import { hasPermission } from "../lib/permissions";
import { fmtMoney2 } from "../lib/formatters";
import { formatDate } from "../lib/datetime";
import { tNodes, useT } from "../i18n";
import styles from "./BankCategoryCell.module.css";

// The category cell of a bank row: one shared control for the Bank
// transactions page and the Monthly P&L's Transactions tab. Pick a
// category and it POSTs /bank/transactions/{id}/categorize. A daily
// book category books the row on that day's book and links to it; a
// locked day comes back as a 409 the cell turns into "book on another
// day"; "Change day" moves the booking day (the server remembers it).
// With the Monthly P&L's transactions on, putting a row on a P&L line
// while a daily book check may be the same money comes back as a 409
// too: the cell offers to link that entry or to say it is different
// money (Monthly INVARIANTS "Transactions").

/** The fields the cell reads, so any list of bank rows can use it. */
export type CategoryCellRow = Pick<
  BankTransactionRow,
  "id" | "category_slug" | "booked_on" | "report_date_override" | "bank_date"
>;

export function BankCategoryCell({
  row, groups, labels, bookable, onChanged, onMakeRule,
}: {
  row: CategoryCellRow;
  groups: BankCategoryGroup[] | undefined;
  labels: Map<string, string>;
  bookable: Set<string>;
  onChanged: () => void;
  onMakeRule: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A locked day: the slug the operator picked + the date the
  // server refused, so the cell can offer another day.
  const [locked, setLocked] = useState<{ slug: string; date: string } | null>(null);
  // The line this row already booked sits on a locked day: untagging
  // or re-tagging would change that day, so the only way on is to
  // unlock it — no other day to offer.
  const [lockedLine, setLockedLine] = useState<string | null>(null);
  // Open when the operator is choosing the day this row books on.
  const [choosingDay, setChoosingDay] = useState(false);
  // The double-count guard (Monthly INVARIANTS "Transactions"): the
  // P&L line picked and the daily book entries that may be the same
  // money, until the person links one or says it is different.
  const [twins, setTwins] = useState<{ slug: string; candidates: DailyTwin[] } | null>(null);

  // `day` mirrors the endpoint's tri-state: undefined keeps the day
  // the row already carries, a date sets it, null clears it back to
  // the bank's posting date.
  async function pick(slug: string, day?: string | null, force = false) {
    setErr(null); setBusy(true);
    try {
      if (slug === "") {
        await uncategorizeTransaction(row.id);
      } else {
        const resp = await categorizeTransaction(row.id, {
          target_kind: slug,
          post_to_daily: true,
          ...(day !== undefined ? { report_date: day } : {}),
          ...(force ? { force: true } : {}),
        });
        const txn = resp.transaction;
        if (txn.booked_on) {
          toast({
            message: t("bankTxn.bookedToast", { date: formatDate(txn.booked_on) }),
            tone: "success",
          });
        }
      }
      setLocked(null);
      setLockedLine(null);
      setChoosingDay(false);
      setTwins(null);
      onChanged();
    } catch (e) {
      const lockedDay = lockedDayFromError(e);
      const maybeTwins = dailyTwinsFromError(e);
      if (maybeTwins) {
        setTwins({ slug, candidates: maybeTwins });
      } else if (lockedDay && lockedDay.report_date === row.booked_on) {
        setLockedLine(lockedDay.report_date);
        setLocked(null);
        setChoosingDay(false);
      } else if (lockedDay) {
        setLocked({ slug, date: lockedDay.report_date });
        setChoosingDay(false);
      } else {
        setErr(apiErrorMessage(e, t("bankTxn.updateFailed")));
      }
    } finally {
      setBusy(false);
    }
  }

  async function link(lineId: number) {
    setErr(null); setBusy(true);
    try {
      await matchTransaction(row.id, [lineId]);
      setTwins(null);
      toast({ message: t("bankCat.twinLinked"), tone: "success" });
      onChanged();
    } catch (e) {
      setErr(apiErrorMessage(e, t("bankTxn.updateFailed")));
    } finally {
      setBusy(false);
    }
  }

  const booksALine = Boolean(row.category_slug) && bookable.has(row.category_slug);

  const label = labels.get(row.category_slug) ?? row.category_slug;

  // Read-only for anyone who cannot categorise: the label instead
  // of a dropdown that would 403 on change.
  if (!hasPermission("bank_sync", "update")) {
    return (
      <div className={styles.categoryCell}>
        <span className={row.category_slug ? styles.categorySelectMono : undefined}>
          {row.category_slug ? label : t("bankTxn.uncategorized")}
        </span>
        <BookedLink row={row} />
      </div>
    );
  }

  return (
    <div className={styles.categoryCell}>
      <Select
        value={row.category_slug}
        onChange={(e) => pick(e.target.value)}
        disabled={busy}
        aria-label={t("bankTxn.category")}
        className={
          row.category_slug
            ? `${styles.categorySelect} ${styles.categorySelectMono}`
            : styles.categorySelect
        }
      >
        <option value="">{t("bankTxn.uncategorized")}</option>
        <BankCategoryOptions groups={groups} />
        {row.category_slug && !labels.has(row.category_slug) && (
          <option value={row.category_slug}>{row.category_slug}</option>
        )}
      </Select>
      <BookedLink row={row} />
      {booksALine && !row.booked_on && !locked && (
        <span
          className={styles.notBooked}
          title={
            row.report_date_override
              ? t("bankTxn.taggedFor", { date: formatDate(row.report_date_override) })
              : t("bankTxn.taggedNoLine")
          }
        >
          {t("bankTxn.notBooked")}
          {row.report_date_override && ` · ${formatDate(row.report_date_override)}`}
        </span>
      )}
      {booksALine && !locked && !choosingDay && (
        <Button
          tone="ghost" size="sm"
          disabled={busy}
          onClick={() => setChoosingDay(true)}
          title={t("bankTxn.changeDayTip")}
        >
          {row.booked_on ? t("bankTxn.changeDay") : t("bankTxn.pickDay")}
        </Button>
      )}
      <Button
        tone="ghost" size="sm" perm="bank_sync.create"
        onClick={onMakeRule}
        title={t("bankTxn.makeRuleTip")}
      >
        {t("bankTxn.makeRule")}
      </Button>
      {err && (
        <span title={err} className={styles.errorMark} role="alert">
          ⚠ {err}
        </span>
      )}
      {choosingDay && (
        <BookDayForm
          initial={row.booked_on || row.report_date_override || row.bank_date}
          busy={busy}
          lead={
            <>
              {t("bankTxn.bookOnLead")}{" "}
              {row.bank_date
                ? t("bankTxn.bankPosted", { date: formatDate(row.bank_date) })
                : ""}
            </>
          }
          onConfirm={(d) => { void pick(row.category_slug, d); }}
          onUseBankDate={
            row.report_date_override
              ? () => { void pick(row.category_slug, null); }
              : undefined
          }
          onCancel={() => setChoosingDay(false)}
        />
      )}
      {lockedLine && (
        <div className={styles.lockedRow} role="alert">
          <span>
            {tNodes("bankTxn.lockedLine", {
              date: formatDate(lockedLine),
              link: <AppLink to={`/daily/edit?date=${lockedLine}`}>{t("bankTxn.openIt")}</AppLink>,
            })}
          </span>
          <Button size="sm" tone="secondary" onClick={() => setLockedLine(null)}>
            {t("bankTxn.ok")}
          </Button>
        </div>
      )}
      {twins && (
        <div className={styles.lockedRow} role="alert">
          <span>{t("bankCat.twinsLead")}</span>
          {twins.candidates.map((c) => (
            <Button
              key={c.id} size="sm" tone="secondary" disabled={busy}
              onClick={() => { void link(c.id); }}
            >
              {t("bankCat.twinSame", {
                kind: c.kind_label,
                amount: fmtMoney2(c.amount),
                date: formatDate(c.report_date),
              })}
            </Button>
          ))}
          <Button
            size="sm" tone="ghost" disabled={busy}
            onClick={() => { void pick(twins.slug, undefined, true); }}
          >
            {t("bankCat.twinDifferent")}
          </Button>
          <Button size="sm" tone="ghost" disabled={busy} onClick={() => setTwins(null)}>
            {t("bankTxn.cancel")}
          </Button>
        </div>
      )}
      {locked && (
        <BookDayForm
          alert
          initial=""
          busy={busy}
          lead={
            <>
              {tNodes("bankTxn.lockedDay", {
                date: formatDate(locked.date),
                link: <AppLink to={`/daily/edit?date=${locked.date}`}>{t("bankTxn.openIt")}</AppLink>,
              })}
            </>
          }
          onConfirm={(d) => { void pick(locked.slug, d); }}
          onCancel={() => setLocked(null)}
        />
      )}
    </div>
  );
}

/** Pick the day a transaction books on. Two callers — the operator
 *  changing the day on purpose, and the locked-day recovery after a
 *  409 — so it lives here rather than twice inside the cell. The
 *  date lives in this component's state and resets when it
 *  unmounts, which is what closing the form should do. */
function BookDayForm({
  lead, initial, busy, alert = false, onConfirm, onCancel, onUseBankDate,
}: {
  lead: ReactNode;
  /** Day the input starts on; "" leaves it empty. */
  initial: string;
  busy: boolean;
  /** Render as a warning callout (the locked-day case). */
  alert?: boolean;
  onConfirm: (day: string) => void;
  onCancel: () => void;
  /** Offered only when the row carries a day of its own to drop. */
  onUseBankDate?: () => void;
}) {
  const [day, setDay] = useState(initial);
  const t = useT();
  return (
    <div className={styles.lockedRow} role={alert ? "alert" : "group"}>
      <span>{lead}</span>
      <DateInput
        value={day}
        onChange={(e) => setDay(e.target.value)}
        aria-label={t("bankTxn.bookOnDate")}
      />
      <Button
        size="sm" disabled={!day || busy} busy={busy}
        onClick={() => onConfirm(day)}
      >
        {t("bankTxn.book")}
      </Button>
      {onUseBankDate && (
        <Button size="sm" tone="ghost" disabled={busy} onClick={onUseBankDate}>
          {t("bankTxn.useBankDate")}
        </Button>
      )}
      <Button size="sm" tone="secondary" disabled={busy} onClick={onCancel}>
        {t("bankTxn.cancel")}
      </Button>
    </div>
  );
}


function BookedLink({ row }: { row: CategoryCellRow }) {
  const t = useT();
  if (!row.booked_on) return null;
  return (
    <AppLink
      to={`/daily/edit?date=${row.booked_on}`}
      className={styles.bookedLink}
      title={t("bankTxn.openDayTip")}
    >
      {t("bankTxn.booked", { date: formatDate(row.booked_on) })}
    </AppLink>
  );
}
