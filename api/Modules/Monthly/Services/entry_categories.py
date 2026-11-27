"""Daily book entries on another P&L line (`pl_transactions` only) —
Monthly INVARIANTS "Daily entries on another line".

A cash / check expense or purchase entry counts on the line its kind
feeds ("Cash expenses"). A person can put it on another EXPENSE line
instead — a `pl_*` column ("Accounting") or a store category
(`plc_<id>`) — through `DailyLineItem.pl_category`. The daily book
itself is untouched (same money, same day, same drawer), which is why
it may change on a locked day.

The month then reads (`apply_moves`, on read AND on save):

* the kind's line, less the moved entries;
* a `pl_*` column: the bank's sum for it plus the moved entries when
  the bank feeds it, else just the moved entries (they speak for the
  line the way the daily book does — a typed value no longer counts);
* a store category: its bank sum plus the moved entries.

Switch off: nothing moves, whatever is stored.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

# The lines whose entries can be moved. Payroll stays on payroll.
MOVABLE_LINES: tuple[str, ...] = (
    "cash_purchases", "check_purchases", "cash_expenses", "check_expenses",
)


def movable_kinds() -> dict[str, str]:
    """daily line-item kind → its line, for the kinds that can move."""
    from api.Modules.Monthly.Services.ledger import _kind_lines

    return {k: line for k, line in _kind_lines().items() if line in MOVABLE_LINES}


def target_options(db: Session, store_id: int) -> list[tuple[str, str]]:
    """Where an entry can go: the store's expense `pl_*` options (as
    its bank picker names them) and its active expense categories."""
    from api.Modules.BankSync.Services.categories import (
        BANK_PL_CATEGORIES, _pl_options,
    )
    from api.Modules.Monthly.Services import custom_categories
    from api.Modules.Monthly.Services.monthly import EXPENSE_FIELDS

    out = [
        (slug, label) for slug, label in _pl_options(db, store_id)
        if BANK_PL_CATEGORIES.get(slug) in EXPENSE_FIELDS
    ]
    out += [
        (c.slug, str(c.name))
        for c in custom_categories.store_categories(db, store_id, include_archived=False)
        if c.section == "expense"
    ]
    return out


def is_valid_target(db: Session, store_id: int, slug: str) -> bool:
    return any(slug == s for s, _ in target_options(db, store_id))


def _target_line(slug: str, custom: dict[str, Any]) -> str | None:
    """The P&L line a stored `pl_category` counts on, or None when it
    no longer means anything (then the entry stays on its own line)."""
    from api.Modules.BankSync.Services.categories import BANK_PL_CATEGORIES
    from api.Modules.Monthly.Services.monthly import EXPENSE_FIELDS

    col = BANK_PL_CATEGORIES.get(slug)
    if col in EXPENSE_FIELDS:
        return col
    c = custom.get(slug)
    if c is not None and c.section == "expense":
        return slug
    return None


@dataclass
class EntryMoves:
    # line → dollars taken off it
    out: dict[str, float] = field(default_factory=dict)
    # `pl_*` column or `plc_<id>` slug → dollars put on it
    into: dict[str, float] = field(default_factory=dict)
    # entry id → the line it counts on now
    targets: dict[int, str] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.targets)


def entry_moves(db: Session, store_id: int, year: int, month: int) -> EntryMoves:
    """The month's moved entries (by their daily book day)."""
    from api.Modules.DailyBook.Models import DailyLineItem
    from api.Modules.Monthly.Services import custom_categories
    from api.Modules.Monthly.Services.daily_feed import month_bounds

    moves = EntryMoves()
    if not custom_categories.enabled(db, store_id):
        return moves
    kinds = movable_kinds()
    start, end = month_bounds(year, month)
    items = db.query(DailyLineItem).filter(
        DailyLineItem.store_id == store_id,
        DailyLineItem.report_date >= start,
        DailyLineItem.report_date <= end,
        DailyLineItem.kind.in_(list(kinds)),
        DailyLineItem.pl_category.isnot(None),
        DailyLineItem.pl_category != "",
    ).all()
    if not items:
        return moves
    custom = {c.slug: c for c in custom_categories.store_categories(db, store_id)}
    out_c: dict[str, int] = {}
    into_c: dict[str, int] = {}
    for i in items:
        target = _target_line(str(i.pl_category), custom)
        if target is None:
            continue
        cents = int(i.amount_cents or 0)
        line = kinds[str(i.kind)]
        out_c[line] = out_c.get(line, 0) + cents
        into_c[target] = into_c.get(target, 0) + cents
        moves.targets[int(i.id)] = target
    moves.out = {k: v / 100.0 for k, v in out_c.items()}
    moves.into = {k: v / 100.0 for k, v in into_c.items()}
    return moves


def apply_moves(
    moves: EntryMoves, derived: dict[str, float], fed: dict[str, float],
    bank: dict[str, float],
) -> dict[str, float]:
    """Move the money in the month's dicts (the daily feed's `derived`
    and `fed`, the bank feed) in place; answer what goes to store
    categories (slug → dollars)."""
    from api.Modules.Monthly.Services.custom_categories import PREFIX

    for line, amount in moves.out.items():
        if line in derived:
            derived[line] = round(derived[line] - amount, 2)
    custom: dict[str, float] = {}
    for target, amount in moves.into.items():
        if target.startswith(PREFIX):
            custom[target] = amount
        elif target in bank:
            bank[target] = round(bank[target] + amount, 2)
        else:
            fed[target] = round(fed.get(target, 0.0) + amount, 2)
    return custom


def history_suggestions(
    db: Session, store_id: int, entries: list[Any],
) -> dict[int, str]:
    """``{entry id: pl_category}`` for entries with none: the store's
    newest moved entry of the same kind with the same note words, if
    that line is still a target."""
    from api.Modules.DailyBook.Models import DailyLineItem
    from api.Modules.Monthly.Services.suggestions import description_words

    if not entries:
        return {}
    allowed = {s for s, _ in target_options(db, store_id)}
    past: dict[tuple[str, str], str] = {}
    for i in db.query(DailyLineItem).filter(
        DailyLineItem.store_id == store_id,
        DailyLineItem.kind.in_(list(movable_kinds())),
        DailyLineItem.pl_category.isnot(None),
        DailyLineItem.pl_category != "",
    ).order_by(DailyLineItem.report_date.desc(), DailyLineItem.id.desc()).limit(2000):
        words = description_words(str(i.note or ""))
        if words:
            past.setdefault((str(i.kind), words), str(i.pl_category))
    out: dict[int, str] = {}
    for e in entries:
        words = description_words(e.note or "")
        slug = past.get((str(e.kind), words)) if words else None
        if slug and slug in allowed:
            out[int(e.id)] = slug
    return out
