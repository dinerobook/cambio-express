"""A store's own P&L categories (`MonthlyPLCategory`, owner
2026-11-27: as many as it likes) — Monthly INVARIANTS "Store
categories".

Only with the Transactions tab on (`pl_transactions`): off, the
store has none (none offered, none counted). A bank row goes on one
with the slug ``plc_<id>``; the month counts Σ |amount| of those rows
by their booking day, in the category's half of the P&L.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

PREFIX = "plc_"
SECTIONS = ("income", "expense")
MAX_NAME = 60


class CategoryError(ValueError):
    """A name that is empty, too long or already taken."""


def category_id(slug: str | None) -> int | None:
    """The category id a ``plc_<id>`` slug names, else None."""
    if not slug or not slug.startswith(PREFIX):
        return None
    tail = slug[len(PREFIX):]
    return int(tail) if tail.isdigit() else None


def enabled(db: Session, store_id: int) -> bool:
    from api.Modules.Monthly.Services.ledger import pl_transactions_enabled
    return pl_transactions_enabled(db, store_id)


def store_categories(
    db: Session, store_id: int, *, include_archived: bool = True,
) -> list[Any]:
    from api.Modules.Monthly.Models import MonthlyPLCategory

    q = db.query(MonthlyPLCategory).filter(MonthlyPLCategory.store_id == store_id)
    if not include_archived:
        q = q.filter(MonthlyPLCategory.archived_at.is_(None))
    return list(q.order_by(MonthlyPLCategory.section.desc(), MonthlyPLCategory.name))


def _clean(name: str) -> str:
    text = " ".join((name or "").split())
    if not text:
        raise CategoryError("Give the category a name.")
    if len(text) > MAX_NAME:
        raise CategoryError(f"Keep the name to {MAX_NAME} characters.")
    return text


def _taken(db: Session, store_id: int, name: str, but: int | None = None) -> bool:
    return any(
        c.name.lower() == name.lower() and c.id != but and c.archived_at is None
        for c in store_categories(db, store_id)
    )


def create_category(db: Session, store_id: int, name: str, section: str) -> Any:
    from api.Modules.Monthly.Models import MonthlyPLCategory

    text = _clean(name)
    if section not in SECTIONS:
        raise CategoryError("Pick income or expense.")
    if _taken(db, store_id, text):
        raise CategoryError("The store already has a category with that name.")
    row = MonthlyPLCategory(store_id=store_id, name=text, section=section)
    db.add(row)
    db.flush()
    return row


def find_category(db: Session, store_id: int, cat_id: int) -> Any | None:
    from api.Modules.Monthly.Models import MonthlyPLCategory

    row = db.get(MonthlyPLCategory, cat_id)
    return row if row is not None and int(row.store_id) == store_id else None


def rename_category(db: Session, row: Any, name: str) -> Any:
    text = _clean(name)
    if _taken(db, int(row.store_id), text, but=int(row.id)):
        raise CategoryError("The store already has a category with that name.")
    row.name = text
    return row


def in_use(db: Session, store_id: int) -> dict[int, int]:
    """``{category id: bank rows and daily entries on it}``, ever."""
    from api.Modules.BankSync.Models import BankTransaction

    out: dict[int, int] = {}
    for slug, n in db.query(
        BankTransaction.category_slug, func.count(BankTransaction.id),
    ).filter(
        BankTransaction.store_id == store_id,
        BankTransaction.category_slug.like(f"{PREFIX}%"),
    ).group_by(BankTransaction.category_slug):
        cid = category_id(str(slug))
        if cid is not None:
            out[cid] = int(n)
    # Daily entries put on one (`entry_categories.py`) count too.
    from api.Modules.DailyBook.Models import DailyLineItem
    for slug, n in db.query(
        DailyLineItem.pl_category, func.count(DailyLineItem.id),
    ).filter(
        DailyLineItem.store_id == store_id,
        DailyLineItem.pl_category.like(f"{PREFIX}%"),
    ).group_by(DailyLineItem.pl_category):
        cid = category_id(str(slug))
        if cid is not None:
            out[cid] = out.get(cid, 0) + int(n)
    return out


@dataclass
class CustomLine:
    id: int
    slug: str
    name: str
    section: str
    amount: float


def custom_lines_for_month(
    db: Session, store_id: int, year: int, month: int,
) -> list[CustomLine]:
    """The month's figure for every store category with rows on it
    (by booking day; dismissed and void rows count nowhere). Empty
    with the switch off."""
    from api.Modules.BankSync.Models import BankTransaction
    from api.Modules.BankSync.Services.charges import month_clauses

    if not enabled(db, store_id):
        return []
    sums = {
        str(slug): int(cents or 0)
        for slug, cents in db.query(
            BankTransaction.category_slug,
            func.coalesce(func.sum(func.abs(BankTransaction.amount_cents)), 0),
        ).filter(
            BankTransaction.store_id == store_id,
            BankTransaction.category_slug.like(f"{PREFIX}%"),
            *month_clauses(year, month, by_booking_day=True),
        ).group_by(BankTransaction.category_slug)
    }
    return [
        CustomLine(
            id=int(c.id), slug=c.slug, name=str(c.name), section=str(c.section),
            amount=round(sums[c.slug] / 100.0, 2),
        )
        for c in store_categories(db, store_id)
        if sums.get(c.slug)
    ]


def category_options(db: Session, store_id: int) -> list[tuple[str, str]]:
    """The store's categories for the bank picker: every active one,
    plus an archived one rows are still on (so they keep a name)."""
    if not enabled(db, store_id):
        return []
    used = in_use(db, store_id)
    return [
        (c.slug, str(c.name) + (" (archived)" if c.archived_at else ""))
        for c in store_categories(db, store_id)
        if c.archived_at is None or int(c.id) in used
    ]
