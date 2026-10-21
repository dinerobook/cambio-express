import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  dismissTransactions,
  keepTypedEntry,
  matchTransaction,
  rejectMatch,
  restoreTransaction,
  runMatching,
  unmatchTransaction,
  useMatchCandidates,
  usePossibleDoubles,
  type BankTransactionRow,
  type BooksCounts,
  type MatchCandidate,
  type MatchedEntry,
} from "../api/bankSync";
import {
  Alert, AppLink, Button, Card, ConfirmDialog, DateInput, Empty, ErrorState, Field,
  Loading, Modal, Pill, SectionTitle, useToast,
  type PillTone,
} from "../components/ui";
import { apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { formatDate } from "../lib/datetime";
import { fmtCount, fmtMoney2 } from "../lib/formatters";
import { canDismissRow, dayGap } from "../lib/bankMatching";
import { hasPermission } from "../lib/permissions";
import styles from "./BankTransactions.module.css";

// Bank transactions matched to daily book entries (BankSync
// INVARIANTS.md "Matching"). Everything here renders only for a
// store with bank matching switched on: the list response says so
// (`matching_enabled`) and every row carries `books_status`.
//
// One pill per row, one meaning per tone (UI-STANDARDS "Pills"):
// green = on the daily book (matched / added from bank), amber =
// a person decides (check match), grey = nothing yet (not on books,
// dismissed).

const PILL: Record<string, { label: string; tone: PillTone }> = {
  matched:      { label: "Matched",        tone: "accent" },
  added:        { label: "Added from bank", tone: "accent" },
  suggested:    { label: "Check match",    tone: "warning" },
  not_on_books: { label: "Not on books",   tone: "neutral" },
  dismissed:    { label: "Dismissed",      tone: "neutral" },
};

function entryText(e: MatchedEntry): string {
  return `${e.kind_label}, ${formatDate(e.report_date)}`;
}

function useRefreshBank() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: ["bank"] }); };
}

/** Store-wide counts, the "To review" filter, Match now, and the
 *  admin's bulk dismiss. */
export function BooksSummary({
  counts, reviewOnly, onReviewOnly, ticked, onClearTicked,
}: {
  counts: BooksCounts | null | undefined;
  reviewOnly: boolean;
  onReviewOnly: (on: boolean) => void;
  ticked: number[];
  onClearTicked: () => void;
}) {
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const refresh = useRefreshBank();
  const [busy, setBusy] = useState(false);
  const [confirmTicked, setConfirmTicked] = useState(false);
  const [beforeOpen, setBeforeOpen] = useState(false);
  const [before, setBefore] = useState("");
  const [beforeConfirm, setBeforeConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function dismiss(body: { ids: number[] } | { before: string }) {
    setBusy(true); setErr(null);
    try {
      const r = await dismissTransactions(body);
      toast({
        message:
          `${fmtCount(r.dismissed, "transaction")} dismissed.`
          + (r.skipped ? ` ${fmtCount(r.skipped, "transaction")} already on the books left alone.` : ""),
        tone: "success",
      });
      setConfirmTicked(false); setBeforeConfirm(false); setBeforeOpen(false);
      setBefore("");
      onClearTicked();
      refresh();
    } catch (e) {
      setErr(apiErrorMessage(e, "Could not dismiss."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.booksSummary} aria-label="Daily book matching">
      <span className={styles.booksCounts}>
        {fmtCount(counts?.matched ?? 0, "matched", "matched")}
        {" · "}{fmtCount(counts?.added ?? 0, "added from bank", "added from bank")}
        {" · "}<strong>{fmtCount(counts?.to_review ?? 0, "to review", "to review")}</strong>
        {(counts?.dismissed ?? 0) > 0 && ` · ${fmtCount(counts?.dismissed ?? 0, "dismissed", "dismissed")}`}
      </span>
      <div className={styles.headerActions}>
        <Button
          size="sm" tone={reviewOnly ? "primary" : "secondary"}
          aria-pressed={reviewOnly}
          onClick={() => onReviewOnly(!reviewOnly)}
        >
          {reviewOnly ? "Showing to review" : "To review"}
        </Button>
        <Button
          size="sm" tone="secondary" perm="bank_sync.update" busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await runMatching();
              toast({
                message: r.matched
                  ? `${fmtCount(r.matched, "transaction")} matched to the daily book.`
                  : "Nothing new to match.",
                tone: "success",
              });
              refresh();
            } catch (e) {
              toastApiError(e, "Could not match.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Match now
        </Button>
        {ticked.length > 0 && (
          <Button size="sm" tone="secondary" perm="bank_dismiss.update"
            onClick={() => { setErr(null); setConfirmTicked(true); }}>
            Dismiss ticked ({ticked.length})
          </Button>
        )}
        <Button size="sm" tone="ghost" perm="bank_dismiss.update"
          onClick={() => { setErr(null); setBeforeOpen(true); }}>
          Dismiss before a date
        </Button>
      </div>

      <ConfirmDialog
        open={confirmTicked}
        title={`Dismiss ${fmtCount(ticked.length, "transaction")}?`}
        message="They won't be added to or matched with the daily book. You can restore any of them later."
        confirmLabel="Dismiss" confirmTone="danger" busy={busy} error={err}
        onConfirm={() => { void dismiss({ ids: ticked }); }}
        onCancel={() => setConfirmTicked(false)}
      />

      <Modal
        open={beforeOpen && !beforeConfirm}
        onClose={() => setBeforeOpen(false)}
        title="Dismiss transactions before a date"
        size="sm"
        actions={
          <>
            <Button tone="secondary" onClick={() => setBeforeOpen(false)}>Cancel</Button>
            <Button disabled={!before} onClick={() => setBeforeConfirm(true)}>Continue</Button>
          </>
        }
      >
        <p className={styles.modalLead}>
          Every transaction still to review, posted on or before this day, is
          marked as already handled. Transactions already on the books stay as
          they are.
        </p>
        <Field label="On or before">
          <DateInput value={before} onChange={(e) => setBefore(e.target.value)} />
        </Field>
      </Modal>

      <ConfirmDialog
        open={beforeConfirm}
        title={before ? `Dismiss everything to review up to ${formatDate(before)}?` : "Dismiss?"}
        message="They won't be added to or matched with the daily book. You can restore any of them later."
        confirmLabel="Dismiss" confirmTone="danger" busy={busy} error={err}
        onConfirm={() => { void dismiss({ before }); }}
        onCancel={() => setBeforeConfirm(false)}
      />
    </div>
  );
}

/** The row's daily-book pill and what can be done about it. */
export function BooksCell({ row }: { row: BankTransactionRow }) {
  const toast = useToast();
  const refresh = useRefreshBank();
  const [reviewing, setReviewing] = useState(false);
  const [confirm, setConfirm] = useState<"unmatch" | "dismiss" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const status = row.books_status ?? "";
  const pill = PILL[status];
  const canEdit = hasPermission("bank_sync", "update");

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setErr(null);
    try {
      await fn();
      toast({ message: done, tone: "success" });
      setConfirm(null);
      refresh();
    } catch (e) {
      setErr(apiErrorMessage(e, "That didn't work."));
    } finally {
      setBusy(false);
    }
  }

  if (!pill && !(status === "" && !row.category_slug)) return null;
  const entries = row.matched_entries ?? [];

  return (
    <div className={styles.booksCell}>
      {pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
      {status === "matched" && entries.length > 0 && (
        <AppLink
          to={`/daily/edit?date=${entries[0].report_date}`}
          className={styles.bookedLink}
          title="Open that day's daily book"
        >
          {entries.length === 1
            ? entryText(entries[0])
            : `${entries.length} entries, ${formatDate(entries[0].report_date)}`}
        </AppLink>
      )}
      {status === "suggested" && canEdit && (
        <Button size="sm" tone="ghost" onClick={() => setReviewing(true)}>
          Review
        </Button>
      )}
      {(status === "not_on_books" || (status === "" && !row.category_slug)) && canEdit && (
        <Button size="sm" tone="ghost" onClick={() => setReviewing(true)}>
          Find in daily book
        </Button>
      )}
      {status === "matched" && canEdit && (
        <Button size="sm" tone="ghost" onClick={() => { setErr(null); setConfirm("unmatch"); }}>
          Unmatch
        </Button>
      )}
      {canDismissRow(row) && (
        <Button size="sm" tone="ghost" perm="bank_dismiss.update"
          onClick={() => { setErr(null); setConfirm("dismiss"); }}>
          Dismiss
        </Button>
      )}
      {status === "dismissed" && (
        <Button size="sm" tone="ghost" perm="bank_dismiss.update" busy={busy}
          onClick={() => { void run(() => restoreTransaction(row.id), "Restored. It needs review again."); }}>
          Restore
        </Button>
      )}
      {err && !confirm && <span className={styles.errorMark} role="alert">⚠ {err}</span>}

      <ConfirmDialog
        open={confirm === "unmatch"}
        title="Unmatch this transaction?"
        message={
          entries.length > 0
            ? `It stays in the bank list and the ${entryText(entries[0])} entry stays in the daily book. Nothing is deleted, and this pair won't be matched again.`
            : "Nothing is deleted."
        }
        confirmLabel="Unmatch" confirmTone="danger" busy={busy} error={err}
        onConfirm={() => { void run(() => unmatchTransaction(row.id), "Unmatched."); }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "dismiss"}
        title="Dismiss this transaction?"
        message="It won't be added to or matched with the daily book. You can restore it later."
        confirmLabel="Dismiss" confirmTone="danger" busy={busy} error={err}
        onConfirm={() => { void run(() => dismissTransactions({ ids: [row.id] }), "Dismissed."); }}
        onCancel={() => setConfirm(null)}
      />
      {reviewing && (
        <MatchReviewModal row={row} onClose={() => setReviewing(false)} />
      )}
    </div>
  );
}

/** "Check match" / "Find in daily book": the entries this bank row
 *  could be, each with Yes / No. */
export function MatchReviewModal({
  row, onClose,
}: { row: BankTransactionRow; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshBank();
  const cands = useMatchCandidates(row.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function act(c: MatchCandidate, yes: boolean) {
    const key = `${yes ? "y" : "n"}${c.line_ids.join(",")}`;
    setBusy(key); setErr(null);
    try {
      if (yes) {
        await matchTransaction(row.id, c.line_ids);
        toast({ message: `Matched to the ${c.kind_label.toLowerCase()} on ${formatDate(c.report_date)}.`, tone: "success" });
        refresh();
        onClose();
      } else {
        await rejectMatch(row.id, c.line_ids);
        void cands.refetch();
        refresh();
      }
    } catch (e) {
      setErr(apiErrorMessage(e, "That didn't work."));
    } finally {
      setBusy(null);
    }
  }

  const list = cands.data?.candidates ?? [];
  return (
    <Modal
      open
      onClose={onClose}
      title="Is this already in the daily book?"
      size="lg"
      actions={<Button tone="secondary" onClick={onClose}>Close</Button>}
    >
      <p className={styles.modalLead}>
        Bank, {formatDate(row.bank_date || row.posted_at)}:{" "}
        <strong>{row.description || "—"}</strong>{" "}
        <span className={styles.amountNeutral}>{fmtMoney2(Math.abs(row.amount))}</span>
      </p>
      {err && <Alert tone="error">{err}</Alert>}
      {cands.isLoading ? (
        <Loading />
      ) : cands.isError ? (
        <ErrorState
          message={apiErrorMessage(cands.error, "Could not load the daily book entries.")}
          onRetry={() => { void cands.refetch(); }}
        />
      ) : list.length === 0 ? (
        <Empty>
          Nothing in the daily book has this amount near this date. Pick a
          category and a day to add it, or dismiss it if it was handled
          another way.
        </Empty>
      ) : (
        <ul className={styles.candidateList}>
          {list.map((c) => {
            const key = c.line_ids.join(",");
            const entries = c.entries ?? [];
            return (
              <li key={key} className={styles.candidate}>
                <div>
                  <strong>{c.kind_label}</strong>{" "}
                  <AppLink to={`/daily/edit?date=${c.report_date}`}>
                    {formatDate(c.report_date)}
                  </AppLink>
                  {c.by_check_number && <> <Pill tone="accent">Same check number</Pill></>}
                  <div className={styles.candidateMeta}>
                    {entries.length > 1
                      ? `${entries.length} entries that add up: ` + entries.map((e) => fmtMoney2(e.amount)).join(" + ")
                      : fmtMoney2(entries[0]?.amount ?? 0)}
                    {entries.some((e) => e.note) && ` · ${entries.map((e) => e.note).filter(Boolean).join(", ")}`}
                    {` · ${dayGap(c.days_from_bank ?? 0)}`}
                  </div>
                </div>
                <div className={styles.headerActions}>
                  <Button size="sm" busy={busy === `y${key}`} disabled={busy != null}
                    onClick={() => { void act(c, true); }}>
                    Yes, same money
                  </Button>
                  <Button size="sm" tone="secondary" busy={busy === `n${key}`} disabled={busy != null}
                    onClick={() => { void act(c, false); }}>
                    No, different
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/** Money that is probably in the daily book twice: typed by hand
 *  AND added by the bank feed. Shown only when there is some. */
export function PossibleDoublesCard() {
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const refresh = useRefreshBank();
  const doubles = usePossibleDoubles(true);
  const [keep, setKeep] = useState<{ txn: number; line: number; day: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rows = doubles.data?.rows ?? [];
  if (rows.length === 0) return null;
  const canFix = hasPermission("bank_sync", "update");
  const canDelete = hasPermission("daily_book", "delete");

  return (
    <Card>
      <SectionTitle>Possibly in the daily book twice</SectionTitle>
      <p className={styles.modalLead}>
        The bank feed added these, and someone also typed the same amount by
        hand. Keep the typed entry to remove the bank&rsquo;s copy, or say they
        are different.
      </p>
      <ul className={styles.candidateList}>
        {rows.map((d) => (
          <li key={d.transaction.id} className={styles.candidate}>
            <div>
              <strong>{d.typed_entry.kind_label} {fmtMoney2(d.typed_entry.amount)}</strong>
              <div className={styles.candidateMeta}>
                Typed on <AppLink to={`/daily/edit?date=${d.typed_entry.report_date}`}>{formatDate(d.typed_entry.report_date)}</AppLink>
                {" · "}added by the bank on <AppLink to={`/daily/edit?date=${d.bank_entry.report_date}`}>{formatDate(d.bank_entry.report_date)}</AppLink>
                {d.transaction.description && ` · ${d.transaction.description}`}
              </div>
            </div>
            {canFix && (
              <div className={styles.headerActions}>
                {canDelete && (
                  <Button size="sm" onClick={() => {
                    setErr(null);
                    setKeep({ txn: d.transaction.id, line: d.typed_entry.id, day: d.bank_entry.report_date });
                  }}>
                    Keep typed entry
                  </Button>
                )}
                <Button size="sm" tone="secondary" onClick={async () => {
                  try {
                    await rejectMatch(d.transaction.id, [d.typed_entry.id]);
                    toast({ message: "Kept both.", tone: "success" });
                    refresh();
                  } catch (e) {
                    toastApiError(e, "That didn't work.");
                  }
                }}>
                  Not the same
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={keep != null}
        title="Remove the bank's copy?"
        message={keep ? `The entry the bank added on ${formatDate(keep.day)} is removed from the daily book and the bank transaction is matched to the typed one.` : ""}
        confirmLabel="Remove copy" confirmTone="danger" busy={busy} error={err}
        onConfirm={async () => {
          if (!keep) return;
          setBusy(true); setErr(null);
          try {
            await keepTypedEntry(keep.txn, keep.line);
            toast({ message: "Removed the bank's copy.", tone: "success" });
            setKeep(null);
            refresh();
          } catch (e) {
            setErr(apiErrorMessage(e, "Could not remove it."));
          } finally {
            setBusy(false);
          }
        }}
        onCancel={() => setKeep(null)}
      />
    </Card>
  );
}
