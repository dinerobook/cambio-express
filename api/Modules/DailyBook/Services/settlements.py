"""Settlements — cash that is lent out or borrowed and comes back.

An ``other_cash_out`` given to another store / a friend, or an
``other_cash_in`` borrowed from one, can be ticked
``expects_settlement``. It stays OPEN on every later day until
entries of the opposite kind linked to it (``settles_item_id``) add
up to its amount, or until the operator unticks it ("close").

The money itself only ever moves through the two ordinary kinds, so
the day totals, over/short and the monthly P&L are untouched by this
module — the return is booked on the day the cash actually came
back, like any other cash in. See INVARIANTS.md "Settlements".

Held checks use the same machinery: a ``check_hold`` (checks cashed
today, deposited later) is ALWAYS marked, and ``held_check_deposit``
entries linked to it record the checks reaching the bank. Unlike a
cash return, a held-check deposit moves no cash: its kind rolls into
a column that is in no daily total. See INVARIANTS.md "Held checks".

These rules are enforced inside the line-item Service
(``add_line_item`` / ``update_line_item`` / ``delete_line_item``),
not in the controller, so every writer goes through them.
"""
from dataclasses import dataclass, field
from datetime import date
from typing import Iterable

from sqlalchemy import func
from sqlalchemy.orm import Session

from api.Modules.DailyBook.Models import DailyLineItem


# The kinds that can be marked, and the kind that settles each one.
SETTLEMENT_PAIRS: dict[str, str] = {
    "other_cash_out": "other_cash_in",   # lent out → comes back in
    "other_cash_in": "other_cash_out",   # borrowed → paid back out
    "check_hold": "held_check_deposit",  # held → deposited later
}

# Kinds that are always marked: a hold IS an open entry.
ALWAYS_OPEN_KINDS: frozenset[str] = frozenset({"check_hold"})
# Kinds that only exist linked to an open entry they settle.
SETTLES_ONLY_KINDS: frozenset[str] = frozenset({"held_check_deposit"})


def settled_cents(
    db: Session, store_id: int, item_ids: Iterable[int],
    *, exclude_id: int | None = None,
) -> dict[int, int]:
    """Σ amount_cents of the entries settling each of ``item_ids``.
    Ids with no settlement are absent from the result."""
    ids = list(item_ids)
    if not ids:
        return {}
    q = db.query(
        DailyLineItem.settles_item_id,
        func.coalesce(func.sum(DailyLineItem.amount_cents), 0),
    ).filter(
        DailyLineItem.store_id == store_id,
        DailyLineItem.settles_item_id.in_(ids),
    )
    if exclude_id is not None:
        q = q.filter(DailyLineItem.id != exclude_id)
    return {
        int(origin_id): int(total)
        for origin_id, total in q.group_by(DailyLineItem.settles_item_id)
    }


def check_expectation(
    kind: str, report_date: date, settle_by: date | None,
) -> None:
    """Raise when an entry of ``kind`` cannot be marked, or its
    settle-by date is before the day the money left."""
    from api.Modules.DailyBook.Services.line_items import (
        LineItemValidationError,
    )
    if kind not in SETTLEMENT_PAIRS:
        raise LineItemValidationError(
            "Only Other cash out, Other cash in and Checks held "
            "entries can be marked as open.",
        )
    if settle_by is not None and settle_by < report_date:
        raise LineItemValidationError(
            "The settle-by date can't be before the entry's own day.",
        )


def check_settlement(
    db: Session, *, store_id: int, settles_item_id: int, kind: str,
    report_date: date, amount_cents: int, exclude_id: int | None = None,
) -> DailyLineItem:
    """Validate an entry that settles ``settles_item_id`` and return
    the open entry it settles. ``exclude_id`` is the settling entry
    itself when it is being edited, so its old amount isn't counted
    twice."""
    from api.Modules.DailyBook.Services.line_items import (
        LineItemValidationError,
    )
    origin = (
        db.query(DailyLineItem)
          .filter_by(id=settles_item_id, store_id=store_id)
          .first()
    )
    # Same message for a missing id and another store's id.
    if origin is None or not origin.expects_settlement:
        raise LineItemValidationError(
            "That entry isn't open for a return any more.",
        )
    if SETTLEMENT_PAIRS.get(str(origin.kind)) != kind:
        raise LineItemValidationError(
            "Held checks are closed with a held-check deposit."
            if str(origin.kind) in ALWAYS_OPEN_KINDS
            or kind in SETTLES_ONLY_KINDS
            else "A return has to go the opposite way: Other cash in "
            "for a cash out, Other cash out for a cash in.",
        )
    if report_date < origin.report_date:
        raise LineItemValidationError(
            "A return can't be dated before the entry it settles.",
        )
    already = settled_cents(
        db, store_id, [int(origin.id)], exclude_id=exclude_id,
    ).get(int(origin.id), 0)
    if amount_cents > int(origin.amount_cents) - already:
        raise LineItemValidationError(
            "That's more than is still outstanding on this entry.",
        )
    return origin


@dataclass
class OpenSettlement:
    item: DailyLineItem
    settlements: list[DailyLineItem] = field(default_factory=list)

    @property
    def settled_cents(self) -> int:
        return sum(int(s.amount_cents) for s in self.settlements)

    @property
    def outstanding_cents(self) -> int:
        return int(self.item.amount_cents) - self.settled_cents


def list_open_settlements(
    db: Session, store_id: int,
) -> list[OpenSettlement]:
    """Every marked entry of the store with money still outstanding,
    oldest first, each with the entries that settled part of it."""
    origins = (
        db.query(DailyLineItem)
          .filter(
              DailyLineItem.store_id == store_id,
              DailyLineItem.expects_settlement.is_(True),
          )
          .order_by(DailyLineItem.report_date.asc(), DailyLineItem.id.asc())
          .all()
    )
    if not origins:
        return []
    by_id = {int(o.id): OpenSettlement(item=o) for o in origins}
    for s in (
        db.query(DailyLineItem)
          .filter(
              DailyLineItem.store_id == store_id,
              DailyLineItem.settles_item_id.in_(list(by_id)),
          )
          .order_by(DailyLineItem.report_date.asc(), DailyLineItem.id.asc())
    ):
        by_id[int(s.settles_item_id)].settlements.append(s)
    return [o for o in by_id.values() if o.outstanding_cents > 0]
