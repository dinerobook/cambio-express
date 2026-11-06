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
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { t, tn, tNodes, useT, type MessageKey } from "../i18n";
import { BOOKS_STATUS_LABELS, canDismissRow, dayGap } from "../lib/bankMatching";
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

const PILL: Record<string, { label: MessageKey; tone: PillTone }> = {
  matched:      { label: BOOKS_STATUS_LABELS.matched,      tone: "accent" },
  added:        { label: BOOKS_STATUS_LABELS.added,        tone: "accent" },
  suggested:    { label: BOOKS_STATUS_LABELS.suggested,    tone: "warning" },
  not_on_books: { label: BOOKS_STATUS_LABELS.not_on_books, tone: "neutral" },
  dismissed:    { label: BOOKS_STATUS_LABELS.dismissed,    tone: "neutral" },
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
  useT();

  async function dismiss(body: { ids: number[] } | { before: string }) {
    setBusy(true); setErr(null);
    try {
      const r = await dismissTransactions(body);
      toast({
        message:
          tn("match.dismissedToast", r.dismissed, fmtNumber)
          + (r.skipped ? ` ${tn("match.skipped", r.skipped, fmtNumber)}` : ""),
        tone: "success",
      });
      setConfirmTicked(false); setBeforeConfirm(false); setBeforeOpen(false);
      setBefore("");
      onClearTicked();
      refresh();
    } catch (e) {
      setErr(apiErrorMessage(e, t("match.dismissFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.booksSummary} aria-label={t("match.summaryAria")}>
      <span className={styles.booksCounts}>
        {t("match.countMatched", { count: fmtNumber(counts?.matched ?? 0) })}
        {" · "}{t("match.countAdded", { count: fmtNumber(counts?.added ?? 0) })}
        {" · "}<strong>{t("match.countToReview", { count: fmtNumber(counts?.to_review ?? 0) })}</strong>
        {(counts?.dismissed ?? 0) > 0
          && ` · ${t("match.countDismissed", { count: fmtNumber(counts?.dismissed ?? 0) })}`}
      </span>
      <div className={styles.headerActions}>
        <Button
          size="sm" tone={reviewOnly ? "primary" : "secondary"}
          aria-pressed={reviewOnly}
          onClick={() => onReviewOnly(!reviewOnly)}
        >
          {reviewOnly ? t("match.showingToReview") : t("match.toReview")}
        </Button>
        <Button
          size="sm" tone="secondary" perm="bank_sync.update" busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await runMatching();
              toast({
                message: r.matched
                  ? tn("match.matchedToast", r.matched, fmtNumber)
                  : t("match.nothingNew"),
                tone: "success",
              });
              refresh();
            } catch (e) {
              toastApiError(e, t("match.matchFailed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("match.matchNow")}
        </Button>
        {ticked.length > 0 && (
          <Button size="sm" tone="secondary" perm="bank_dismiss.update"
            onClick={() => { setErr(null); setConfirmTicked(true); }}>
            {t("match.dismissTicked", { count: fmtNumber(ticked.length) })}
          </Button>
        )}
        <Button size="sm" tone="ghost" perm="bank_dismiss.update"
          onClick={() => { setErr(null); setBeforeOpen(true); }}>
          {t("match.dismissBefore")}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmTicked}
        title={tn("match.dismissTitle", ticked.length, fmtNumber)}
        message={t("match.dismissBody")}
        confirmLabel={t("match.dismiss")} confirmTone="danger" busy={busy} error={err}
        onConfirm={() => { void dismiss({ ids: ticked }); }}
        onCancel={() => setConfirmTicked(false)}
      />

      <Modal
        open={beforeOpen && !beforeConfirm}
        onClose={() => setBeforeOpen(false)}
        title={t("match.beforeTitle")}
        size="sm"
        actions={
          <>
            <Button tone="secondary" onClick={() => setBeforeOpen(false)}>{t("match.cancel")}</Button>
            <Button disabled={!before} onClick={() => setBeforeConfirm(true)}>{t("match.continue")}</Button>
          </>
        }
      >
        <p className={styles.modalLead}>{t("match.beforeLead")}</p>
        <Field label={t("match.onOrBefore")}>
          <DateInput value={before} onChange={(e) => setBefore(e.target.value)} />
        </Field>
      </Modal>

      <ConfirmDialog
        open={beforeConfirm}
        title={before ? t("match.beforeConfirm", { date: formatDate(before) }) : t("match.dismissShort")}
        message={t("match.dismissBody")}
        confirmLabel={t("match.dismiss")} confirmTone="danger" busy={busy} error={err}
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
  useT();

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setErr(null);
    try {
      await fn();
      toast({ message: done, tone: "success" });
      setConfirm(null);
      refresh();
    } catch (e) {
      setErr(apiErrorMessage(e, t("match.failed")));
    } finally {
      setBusy(false);
    }
  }

  if (!pill && !(status === "" && !row.category_slug)) return null;
  const entries = row.matched_entries ?? [];

  return (
    <div className={styles.booksCell}>
      {pill && <Pill tone={pill.tone}>{t(pill.label)}</Pill>}
      {status === "matched" && entries.length > 0 && (
        <AppLink
          to={`/daily/edit?date=${entries[0].report_date}`}
          className={styles.bookedLink}
          title={t("match.openDayTip")}
        >
          {entries.length === 1
            ? entryText(entries[0])
            : t("match.entries", {
              count: fmtNumber(entries.length), date: formatDate(entries[0].report_date),
            })}
        </AppLink>
      )}
      {status === "suggested" && canEdit && (
        <Button size="sm" tone="ghost" onClick={() => setReviewing(true)}>
          {t("match.review")}
        </Button>
      )}
      {(status === "not_on_books" || (status === "" && !row.category_slug)) && canEdit && (
        <Button size="sm" tone="ghost" onClick={() => setReviewing(true)}>
          {t("match.find")}
        </Button>
      )}
      {status === "matched" && canEdit && (
        <Button size="sm" tone="ghost" onClick={() => { setErr(null); setConfirm("unmatch"); }}>
          {t("match.unmatch")}
        </Button>
      )}
      {canDismissRow(row) && (
        <Button size="sm" tone="ghost" perm="bank_dismiss.update"
          onClick={() => { setErr(null); setConfirm("dismiss"); }}>
          {t("match.dismiss")}
        </Button>
      )}
      {status === "dismissed" && (
        <Button size="sm" tone="ghost" perm="bank_dismiss.update" busy={busy}
          onClick={() => { void run(() => restoreTransaction(row.id), t("match.restored")); }}>
          {t("match.restore")}
        </Button>
      )}
      {err && !confirm && <span className={styles.errorMark} role="alert">⚠ {err}</span>}

      <ConfirmDialog
        open={confirm === "unmatch"}
        title={t("match.unmatchTitle")}
        message={
          entries.length > 0
            ? t("match.unmatchBody", { entry: entryText(entries[0]) })
            : t("match.nothingDeleted")
        }
        confirmLabel={t("match.unmatch")} confirmTone="danger" busy={busy} error={err}
        onConfirm={() => { void run(() => unmatchTransaction(row.id), t("match.unmatched")); }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "dismiss"}
        title={t("match.dismissOneTitle")}
        message={t("match.dismissOneBody")}
        confirmLabel={t("match.dismiss")} confirmTone="danger" busy={busy} error={err}
        onConfirm={() => { void run(() => dismissTransactions({ ids: [row.id] }), t("match.dismissedOne")); }}
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
  useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function act(c: MatchCandidate, yes: boolean) {
    const key = `${yes ? "y" : "n"}${c.line_ids.join(",")}`;
    setBusy(key); setErr(null);
    try {
      if (yes) {
        await matchTransaction(row.id, c.line_ids);
        toast({ message: t("match.matchedTo", { kind: c.kind_label.toLowerCase(), date: formatDate(c.report_date) }), tone: "success" });
        refresh();
        onClose();
      } else {
        await rejectMatch(row.id, c.line_ids);
        void cands.refetch();
        refresh();
      }
    } catch (e) {
      setErr(apiErrorMessage(e, t("match.failed")));
    } finally {
      setBusy(null);
    }
  }

  const list = cands.data?.candidates ?? [];
  return (
    <Modal
      open
      onClose={onClose}
      title={t("match.reviewTitle")}
      size="lg"
      actions={<Button tone="secondary" onClick={onClose}>{t("match.close")}</Button>}
    >
      <p className={styles.modalLead}>
        {t("match.bankLine", { date: formatDate(row.bank_date || row.posted_at) })}{" "}
        <strong>{row.description || "—"}</strong>{" "}
        <span className={styles.amountNeutral}>{fmtMoney2(Math.abs(row.amount))}</span>
      </p>
      {err && <Alert tone="error">{err}</Alert>}
      {cands.isLoading ? (
        <Loading />
      ) : cands.isError ? (
        <ErrorState
          message={apiErrorMessage(cands.error, t("match.loadFailed"))}
          onRetry={() => { void cands.refetch(); }}
        />
      ) : list.length === 0 ? (
        <Empty>{t("match.noCandidates")}</Empty>
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
                  {c.by_check_number && <> <Pill tone="accent">{t("match.sameCheck")}</Pill></>}
                  <div className={styles.candidateMeta}>
                    {entries.length > 1
                      ? t("match.addUp", {
                        count: fmtNumber(entries.length),
                        sum: entries.map((e) => fmtMoney2(e.amount)).join(" + "),
                      })
                      : fmtMoney2(entries[0]?.amount ?? 0)}
                    {entries.some((e) => e.note) && ` · ${entries.map((e) => e.note).filter(Boolean).join(", ")}`}
                    {` · ${dayGap(c.days_from_bank ?? 0)}`}
                  </div>
                </div>
                <div className={styles.headerActions}>
                  <Button size="sm" busy={busy === `y${key}`} disabled={busy != null}
                    onClick={() => { void act(c, true); }}>
                    {t("match.yes")}
                  </Button>
                  <Button size="sm" tone="secondary" busy={busy === `n${key}`} disabled={busy != null}
                    onClick={() => { void act(c, false); }}>
                    {t("match.no")}
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
  useT();
  const [keep, setKeep] = useState<{ txn: number; line: number; day: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rows = doubles.data?.rows ?? [];
  if (rows.length === 0) return null;
  const canFix = hasPermission("bank_sync", "update");
  const canDelete = hasPermission("daily_book", "delete");

  return (
    <Card>
      <SectionTitle>{t("match.doublesTitle")}</SectionTitle>
      <p className={styles.modalLead}>{t("match.doublesLead")}</p>
      <ul className={styles.candidateList}>
        {rows.map((d) => (
          <li key={d.transaction.id} className={styles.candidate}>
            <div>
              <strong>{d.typed_entry.kind_label} {fmtMoney2(d.typed_entry.amount)}</strong>
              <div className={styles.candidateMeta}>
                {tNodes("match.typedOn", {
                  typed: <AppLink to={`/daily/edit?date=${d.typed_entry.report_date}`}>{formatDate(d.typed_entry.report_date)}</AppLink>,
                  bank: <AppLink to={`/daily/edit?date=${d.bank_entry.report_date}`}>{formatDate(d.bank_entry.report_date)}</AppLink>,
                })}
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
                    {t("match.keepTyped")}
                  </Button>
                )}
                <Button size="sm" tone="secondary" onClick={async () => {
                  try {
                    await rejectMatch(d.transaction.id, [d.typed_entry.id]);
                    toast({ message: t("match.keptBoth"), tone: "success" });
                    refresh();
                  } catch (e) {
                    toastApiError(e, t("match.failed"));
                  }
                }}>
                  {t("match.notSame")}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={keep != null}
        title={t("match.removeTitle")}
        message={keep ? t("match.removeBody", { date: formatDate(keep.day) }) : ""}
        confirmLabel={t("match.removeCopy")} confirmTone="danger" busy={busy} error={err}
        onConfirm={async () => {
          if (!keep) return;
          setBusy(true); setErr(null);
          try {
            await keepTypedEntry(keep.txn, keep.line);
            toast({ message: t("match.removed"), tone: "success" });
            setKeep(null);
            refresh();
          } catch (e) {
            setErr(apiErrorMessage(e, t("match.removeFailed")));
          } finally {
            setBusy(false);
          }
        }}
        onCancel={() => setKeep(null)}
      />
    </Card>
  );
}
