"""Bank transactions matched to daily book entries (BankSync
INVARIANTS.md "Matching").

Mounted under ``/bank``:

  GET  /bank/transactions/{id}/candidates  → entries this row could be
  POST /bank/transactions/{id}/match       → "Yes, same money"
  POST /bank/transactions/{id}/reject      → "No, different"
  POST /bank/transactions/{id}/unmatch     → undo a match
  POST /bank/transactions/{id}/use-entry   → in twice: keep the typed
                                              entry, drop the bank's
  POST /bank/transactions/dismiss          → admin: already handled
  POST /bank/transactions/{id}/restore     → admin: undo a dismiss
  GET  /bank/reconcile/doubles             → entries that are in twice
  POST /bank/reconcile/run                 → match every waiting row

Every route needs the store's ``bank_matching`` switch on (403
``matching_off`` otherwise) and writes an operator-audit row. A match
moves no money, so match / reject / unmatch work on a locked day;
use-entry removes the bank's entry and is refused (409) on one.
"""
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy.orm import Session

from api.Core.Clock import utc_now
from api.Core.Database import get_db
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services import resolve_store_scope
from api.Modules.Auth.Services.principal import require_permission
from api.Modules.BankSync.Controllers import (
    _adapt_txn, _audit_bank_action, _entry, _find_owned_txn,
)
from api.Modules.BankSync.Models import BankTransaction
from api.Modules.BankSync.Requests import (
    CategorizeResponse,
    DismissRequest,
    DismissResponse,
    MatchCandidateRow,
    MatchCandidatesResponse,
    MatchLinesRequest,
    PossibleDoubleRow,
    PossibleDoublesResponse,
    ReconcileRunResponse,
    UseEntryRequest,
)
from api.Modules.BankSync.Services import reconcile
from api.Modules.BankSync.Services.categorize import (
    DailyBookLockedError,
    _refuse_locked_line,
    bank_date_for,
    categorize_transaction,
    unbook_from_daily,
)
from api.Modules.DailyBook.Models import DailyLineItem


router = APIRouter()


def _scope(db: Session, claims: dict[str, Any], resource: str, action: str) -> int:
    require_permission(claims, resource, action)
    sid = resolve_store_scope(claims)
    if not reconcile.matching_enabled(db, sid):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "matching_off",
                "message": "Bank matching is not switched on for this store.",
            },
        )
    return sid


def _conflict(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=409, detail={"code": code, "message": message})


def _refuse_dismissed(txn: BankTransaction) -> None:
    if txn.dismissed_at is not None:
        raise _conflict(
            "transaction_dismissed",
            "This transaction was dismissed as already handled. Restore it first.",
        )


def _owned_lines(db: Session, store_id: int, ids: list[int]) -> list[DailyLineItem]:
    want = sorted(set(int(i) for i in ids))
    rows = (
        db.query(DailyLineItem)
          .filter(DailyLineItem.store_id == store_id, DailyLineItem.id.in_(want))
          .order_by(DailyLineItem.id)
          .all()
    )
    if len(rows) != len(want):
        # Same opaque 404 for a missing id and another store's entry.
        raise HTTPException(status_code=404, detail="Daily book entry not found")
    return rows


def _candidate_row(txn: BankTransaction, c: reconcile.Candidate) -> MatchCandidateRow:
    return MatchCandidateRow(
        line_ids=c.line_ids,
        report_date=c.report_date,
        kind=c.kind,
        kind_label=reconcile.line_label(c.kind),
        entries=[_entry(x) for x in c.lines],
        by_check_number=c.by_check_number,
        days_from_bank=(bank_date_for(txn) - c.report_date).days,
    )


@router.get(
    "/transactions/{txn_id}/candidates",
    response_model=MatchCandidatesResponse,
)
def candidates_route(
    txn_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MatchCandidatesResponse:
    """The daily book entries this bank row could be — the "Check
    match" choices and "Find in daily book". Rejected pairs and
    entries already in the bank are left out."""
    sid = _scope(db, claims, "bank_sync", "read")
    txn = _find_owned_txn(db, sid, txn_id)
    if txn.dismissed_at is not None:
        return MatchCandidatesResponse()
    idx = reconcile.CandidateIndex(db, sid, [txn])
    return MatchCandidatesResponse(candidates=[
        _candidate_row(txn, c) for c in idx.candidates(txn)
    ])


@router.post(
    "/transactions/{txn_id}/match",
    response_model=CategorizeResponse,
)
def match_route(
    body: MatchLinesRequest,
    txn_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CategorizeResponse:
    """"Yes, same money": link this bank row to the entries a person
    picked. They must be one day's entries of one matchable kind
    that add up to the bank amount exactly, going the bank's way,
    inside the date window, and not already in the bank. An untagged
    row takes the entries' tag (nothing is booked)."""
    sid = _scope(db, claims, "bank_sync", "update")
    txn = _find_owned_txn(db, sid, txn_id)
    _refuse_dismissed(txn)
    if reconcile._has_live_booked_line(db, txn):
        raise _conflict(
            "already_on_books",
            "The bank already added this transaction to the daily book.",
        )
    if reconcile.matched_lines(db, txn):
        raise _conflict("already_matched", "This transaction is already matched. Unmatch it first.")
    lines = _owned_lines(db, sid, body.line_ids)
    kinds = {str(x.kind) for x in lines}
    days = {x.report_date for x in lines}
    if len(kinds) != 1 or len(days) != 1:
        raise HTTPException(
            status_code=422,
            detail="Pick entries of one kind from one day.",
        )
    kind = kinds.pop()
    tag = reconcile.TAG_FOR_LINE_KIND.get(kind)
    if tag is None:
        raise HTTPException(
            status_code=422,
            detail="That kind of entry never reaches the bank, so it can't be matched.",
        )
    rule = reconcile.MATCH_RULES[tag]
    if txn.category_slug and txn.category_slug != tag:
        raise HTTPException(
            status_code=422,
            detail=(
                "This transaction is tagged as something else. Change its "
                "category first."
            ),
        )
    if rule.credit != (int(txn.amount_cents or 0) > 0):
        raise HTTPException(
            status_code=422,
            detail="The money goes the other way at the bank.",
        )
    if sum(int(x.amount_cents or 0) for x in lines) != abs(int(txn.amount_cents or 0)):
        raise HTTPException(
            status_code=422,
            detail="The entries don't add up to the bank amount.",
        )
    if not reconcile._in_window(rule, bank_date_for(txn), lines[0].report_date):
        raise HTTPException(
            status_code=422,
            detail="That day is too far from the bank's date for this kind of entry.",
        )
    taken = reconcile._bank_added_line_ids(db, sid) | {
        l for _, l in reconcile._matched_pairs(db, sid)
    }
    if any(int(x.id) in taken for x in lines):
        raise _conflict(
            "entry_taken",
            "One of those entries is already matched to another bank transaction.",
        )
    if not txn.category_slug:
        categorize_transaction(db, txn, tag, post_to_daily=False, match=False)
    reconcile.link(db, txn, lines, method="confirmed", user_id=int(claims["sub"]))
    _audit_bank_action(
        db, claims=claims, action="match_bank_transaction",
        target_type="bank_transaction", target_id=str(txn.id),
        target_label=(txn.description or "")[:160],
        summary=f"entries={','.join(str(x.id) for x in lines)} kind={kind} day={lines[0].report_date.isoformat()}",
    )
    db.commit()
    db.refresh(txn)
    return CategorizeResponse(transaction=_adapt_txn(db, txn))


@router.post(
    "/transactions/{txn_id}/reject",
    response_model=CategorizeResponse,
)
def reject_route(
    body: MatchLinesRequest,
    txn_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CategorizeResponse:
    """"No, different": these entries are not this bank row. Never
    suggested again; nothing in the daily book changes."""
    sid = _scope(db, claims, "bank_sync", "update")
    txn = _find_owned_txn(db, sid, txn_id)
    _refuse_dismissed(txn)
    lines = _owned_lines(db, sid, body.line_ids)
    matched = {int(x.id) for x in reconcile.matched_lines(db, txn)}
    if matched & {int(x.id) for x in lines}:
        raise _conflict("already_matched", "That entry is matched. Use Unmatch instead.")
    reconcile.reject(db, txn, [int(x.id) for x in lines], user_id=int(claims["sub"]))
    _audit_bank_action(
        db, claims=claims, action="reject_bank_match",
        target_type="bank_transaction", target_id=str(txn.id),
        target_label=(txn.description or "")[:160],
        summary=f"entries={','.join(str(x.id) for x in lines)}",
    )
    db.commit()
    db.refresh(txn)
    return CategorizeResponse(transaction=_adapt_txn(db, txn))


@router.post(
    "/transactions/{txn_id}/unmatch",
    response_model=CategorizeResponse,
)
def unmatch_route(
    txn_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CategorizeResponse:
    """Undo a match. Nothing is deleted; the pair is remembered as
    "not the same" so the next sync does not match it straight
    back. Allowed on a locked day: no money moves."""
    sid = _scope(db, claims, "bank_sync", "update")
    txn = _find_owned_txn(db, sid, txn_id)
    _refuse_dismissed(txn)
    ids = reconcile.unmatch(db, txn, user_id=int(claims["sub"]))
    if not ids:
        raise _conflict("not_matched", "This transaction isn't matched to anything.")
    _audit_bank_action(
        db, claims=claims, action="unmatch_bank_transaction",
        target_type="bank_transaction", target_id=str(txn.id),
        target_label=(txn.description or "")[:160],
        summary=f"entries={','.join(str(i) for i in ids)}",
    )
    db.commit()
    db.refresh(txn)
    return CategorizeResponse(transaction=_adapt_txn(db, txn))


@router.post(
    "/transactions/{txn_id}/use-entry",
    response_model=CategorizeResponse,
)
def use_entry_route(
    body: UseEntryRequest,
    txn_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CategorizeResponse:
    """The same money is in twice — once typed, once added by the
    bank. Keep the typed entry: remove the bank's entry (rolling
    its day back) and match the bank row to the typed one. Removing
    an entry needs Delete on the daily book, and a locked day
    refuses (409) — unlock it first."""
    sid = _scope(db, claims, "bank_sync", "update")
    require_permission(claims, "daily_book", "delete")
    txn = _find_owned_txn(db, sid, txn_id)
    _refuse_dismissed(txn)
    bank_line = (
        db.get(DailyLineItem, int(txn.daily_line_item_id))
        if txn.daily_line_item_id else None
    )
    if bank_line is None:
        raise _conflict("not_on_books", "The bank didn't add an entry for this transaction.")
    typed = _owned_lines(db, sid, [body.line_id])[0]
    doubles = {
        int(d.typed_line.id) for d in reconcile.possible_doubles(db, sid)
        if int(d.txn.id) == int(txn.id)
    }
    if (
        str(typed.kind) != str(bank_line.kind)
        or int(typed.amount_cents or 0) != int(bank_line.amount_cents or 0)
        or int(typed.id) not in doubles
    ):
        raise HTTPException(
            status_code=422,
            detail="That entry isn't the same money as this transaction.",
        )
    try:
        _refuse_locked_line(db, int(bank_line.id))
    except DailyBookLockedError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "daily_book_locked",
                "report_date": exc.report_date.isoformat(),
                "message": str(exc),
            },
        )
    removed_day = bank_line.report_date.isoformat()
    unbook_from_daily(db, txn)
    reconcile.link(db, txn, [typed], method="confirmed", user_id=int(claims["sub"]))
    _audit_bank_action(
        db, claims=claims, action="keep_typed_entry",
        target_type="bank_transaction", target_id=str(txn.id),
        target_label=(txn.description or "")[:160],
        summary=f"removed bank entry on {removed_day}, matched entry={typed.id}",
    )
    db.commit()
    db.refresh(txn)
    return CategorizeResponse(transaction=_adapt_txn(db, txn))


@router.post("/transactions/dismiss", response_model=DismissResponse)
def dismiss_route(
    body: DismissRequest,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DismissResponse:
    """An admin's "already handled": the ticked rows, or every row
    still needing review posted on or before `before`. Only rows
    still needing review are dismissed — one already on the books
    (added or matched), or tagged to the P&L, is skipped. Nothing
    in the books changes."""
    sid = _scope(db, claims, "bank_dismiss", "update")
    require_permission(claims, "bank_sync", "read")
    if bool(body.ids) == (body.before is not None):
        raise HTTPException(
            status_code=422,
            detail="Send the ticked transactions or a date, not both.",
        )
    review = reconcile.books_clause("review")
    q = db.query(BankTransaction).filter(BankTransaction.store_id == sid)
    if body.ids:
        wanted = set(int(i) for i in body.ids)
        rows = q.filter(BankTransaction.id.in_(wanted)).all()
        if len(rows) != len(wanted):
            raise HTTPException(status_code=404, detail="Bank transaction not found")
        eligible = {
            int(t.id) for t in
            q.filter(BankTransaction.id.in_(wanted), *review)
        }
    else:
        assert body.before is not None
        end = datetime.combine(body.before, datetime.max.time())
        rows = q.filter(*review, BankTransaction.posted_at <= end).all()
        eligible = {int(t.id) for t in rows}
    now = utc_now()
    uid = int(claims["sub"])
    done = 0
    for t in rows:
        if int(t.id) not in eligible:
            continue
        t.dismissed_at = now
        t.dismissed_by = uid
        done += 1
    skipped = len(rows) - done
    _audit_bank_action(
        db, claims=claims, action="dismiss_bank_transactions",
        target_type="bank_transaction",
        target_id=",".join(str(t.id) for t in rows if int(t.id) in eligible)[:60] or "-",
        target_label=(
            f"{done} on or before {body.before.isoformat()}" if body.before
            else f"{done} ticked"
        ),
        summary=f"dismissed={done} skipped={skipped}",
    )
    db.commit()
    return DismissResponse(dismissed=done, skipped=skipped)


@router.post(
    "/transactions/{txn_id}/restore",
    response_model=CategorizeResponse,
)
def restore_route(
    txn_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CategorizeResponse:
    """Undo a dismiss: the row needs review again."""
    sid = _scope(db, claims, "bank_dismiss", "update")
    txn = _find_owned_txn(db, sid, txn_id)
    if txn.dismissed_at is None:
        raise _conflict("not_dismissed", "This transaction isn't dismissed.")
    txn.dismissed_at = None
    txn.dismissed_by = None
    _audit_bank_action(
        db, claims=claims, action="restore_bank_transaction",
        target_type="bank_transaction", target_id=str(txn.id),
        target_label=(txn.description or "")[:160],
    )
    db.commit()
    db.refresh(txn)
    return CategorizeResponse(transaction=_adapt_txn(db, txn))


@router.get("/reconcile/doubles", response_model=PossibleDoublesResponse)
def doubles_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> PossibleDoublesResponse:
    """Money that is probably in the daily book twice: the bank
    added an entry, and a typed entry of the same kind and amount
    sits inside the window. Listed only — a person decides."""
    sid = _scope(db, claims, "bank_sync", "read")
    return PossibleDoublesResponse(rows=[
        PossibleDoubleRow(
            transaction=_adapt_txn(db, d.txn),
            bank_entry=_entry(d.bank_line),
            typed_entry=_entry(d.typed_line),
        )
        for d in reconcile.possible_doubles(db, sid)
    ])


@router.post("/reconcile/run", response_model=ReconcileRunResponse)
def reconcile_run_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReconcileRunResponse:
    """Match every waiting bank row whose entry is surely on the
    books (sync does this on its own; this is the button)."""
    sid = _scope(db, claims, "bank_sync", "update")
    n = reconcile.reconcile_store(db, sid)
    _audit_bank_action(
        db, claims=claims, action="reconcile_bank",
        target_type="bank_transaction", target_id="-",
        target_label="Match now", summary=f"matched={n}",
    )
    db.commit()
    return ReconcileRunResponse(matched=n)
