"""Bank-transaction category assignment — and booking.

Tagging a bank row with a category is one write; the category
decides whether there is a second one:

  * a **daily-book kind** books a `DailyLineItem` on a day's book,
    through the same service path a cashier's entry takes —
    `ensure_daily_report` + `recompute_line_items_total` — so the
    day's rolled-up column (`checks_deposit`, `cash_expense`, …)
    moves at once. Before this, the line was inserted directly and
    the day's total never changed: the operator tagged a batch of
    remote check deposits and the daily book showed nothing.
  * a **`pl_*` category** or a **bank charge** touches nothing here;
    the monthly P&L sums those rows itself (see `charges.py`).
  * everything else is a tag.

A locked day is the kill-switch. Booking onto a locked report is
refused with `DailyBookLockedError`; the rule engine catches that
and keeps the tag without the line (`applier.py`), so a re-sync
never edits a closed day behind the operator's back.
"""
from datetime import date
from typing import Callable

from sqlalchemy.orm import Session

from api.Modules.BankSync.Models import BankRule, BankTransaction
from api.Modules.BankSync.Services.categories import (
    is_daily_book_kind as _registry_is_daily_book_kind,
)
from api.Modules.DailyBook.Models import DailyLineItem
from api.Modules.DailyBook.Repositories import find_report_by_date
from api.Modules.DailyBook.Services import LINE_ITEM_KINDS
from api.Modules.DailyBook.Services.line_items import (
    recompute_line_items_total,
)
from api.Core.Clock import utc_now


class DailyBookLockedError(Exception):
    """The day this transaction would be booked on is locked."""

    def __init__(self, report_date: date) -> None:
        self.report_date = report_date
        super().__init__(
            f"The daily book for {report_date.isoformat()} is locked — "
            "unlock it to book this transaction."
        )


def booking_date_for(txn: BankTransaction, report_date: date | None = None) -> date:
    """The day a transaction lands on: an explicit override, else the
    bank's posting date. The override exists for remote deposits the
    bank posts the next morning that belong on the prior day's
    close-out."""
    if report_date is not None:
        return report_date
    when = txn.posted_at or utc_now()
    return when.date()


def _remove_line(db: Session, line_id: int | None) -> None:
    """Delete a booked line item and roll its day's total back.
    A line the daily book already deleted is a no-op."""
    if not line_id:
        return
    old = db.get(DailyLineItem, line_id)
    if old is None:
        return
    kind = str(old.kind)
    store_id, report_date = int(old.store_id), old.report_date
    db.delete(old)
    db.flush()
    if kind in LINE_ITEM_KINDS:
        recompute_line_items_total(
            db, store_id, report_date,
            kind=kind, daily_report_field=LINE_ITEM_KINDS[kind][0],
        )


def unbook_from_daily(db: Session, txn: BankTransaction) -> None:
    """Delete the line item this transaction created (if any) and
    roll the day's total back. Safe to call when nothing is booked."""
    line_id = txn.daily_line_item_id
    txn.daily_line_item_id = None
    _remove_line(db, line_id)


def book_to_daily(
    db: Session, txn: BankTransaction, kind: str, *,
    report_date: date | None = None,
) -> DailyLineItem:
    """Post `txn` on the daily book as a `kind` line item and roll
    the day's total up. Raises `DailyBookLockedError` for a locked
    day and `ValueError` for a kind that is not a line-item kind."""
    if kind not in LINE_ITEM_KINDS:
        raise ValueError(f"{kind!r} is not a daily-book line-item kind")
    line_date = booking_date_for(txn, report_date)
    existing = find_report_by_date(db, int(txn.store_id), line_date)
    if existing is not None and existing.locked_at is not None:
        raise DailyBookLockedError(line_date)

    when = txn.posted_at or utc_now()
    line = DailyLineItem(
        store_id=txn.store_id,
        report_date=line_date,
        kind=kind,
        at_time=when.time(),
        # Daily-book stores absolute amounts; the kind encodes
        # inflow vs outflow on the report.
        amount=abs(float(txn.amount_cents or 0) / 100.0),
        note=(txn.description or "")[:120],
    )
    db.add(line)
    db.flush()
    txn.daily_line_item_id = line.id
    # Same roll-up a cashier's entry gets: creates the day's report
    # row if this is its first entry, sums the kind, refreshes
    # over/short.
    recompute_line_items_total(
        db, int(txn.store_id), line_date,
        kind=kind, daily_report_field=LINE_ITEM_KINDS[kind][0],
    )
    return line


def categorize_transaction(
    db: Session, txn: BankTransaction, target_kind: str,
    *,
    rule: BankRule | None = None,
    post_to_daily: bool = True,
    report_date: date | None = None,
    is_daily_book_kind: Callable[[str], bool] | None = None,
) -> BankTransaction:
    """Set the transaction's category, booking a daily-book line
    item when the category is a line-item kind and `post_to_daily`
    is on. Idempotent — re-categorizing unbooks any previously
    created line before adding a fresh one, and both steps roll the
    affected day's total.

    `is_daily_book_kind` defaults to the LINE_ITEM_KINDS registry;
    tests may pass a narrower predicate.

    `report_date` overrides the line-item's day — the RDC case
    where the bank posts the transaction the next morning but the
    cash-handling event belongs on the previous day's book.

    Raises `DailyBookLockedError` when the target day is locked.
    The category is NOT applied in that case — the caller decides
    whether to retry without booking (the rule engine does) or to
    surface the lock (the manual endpoint does).
    """
    predicate = is_daily_book_kind or _registry_is_daily_book_kind
    wants_booking = bool(post_to_daily and target_kind and predicate(target_kind))

    # Check the lock BEFORE touching anything so a refused booking
    # leaves the row exactly as it was.
    if wants_booking:
        line_date = booking_date_for(txn, report_date)
        existing = find_report_by_date(db, int(txn.store_id), line_date)
        if existing is not None and existing.locked_at is not None:
            raise DailyBookLockedError(line_date)

    old_line_id = txn.daily_line_item_id
    txn.daily_line_item_id = None
    txn.category_slug = target_kind or ""
    txn.matched_rule_id = rule.id if rule else None

    if rule is not None:
        rule.match_count = (rule.match_count or 0) + 1
        rule.last_matched_at = utc_now()

    # Book the new line BEFORE removing the old one: the fresh row
    # then always gets a new id (SQLite reuses a freed max rowid),
    # so a stale `daily_line_item_id` can never point at the
    # replacement by accident.
    if wants_booking:
        book_to_daily(db, txn, target_kind, report_date=report_date)
    _remove_line(db, old_line_id)
    return txn


def uncategorize_transaction(
    db: Session, txn: BankTransaction,
) -> BankTransaction:
    """Clear category_slug + unbook any line item (rolling the day's
    total back). Caller commits."""
    unbook_from_daily(db, txn)
    txn.category_slug = ""
    txn.matched_rule_id = None
    return txn
