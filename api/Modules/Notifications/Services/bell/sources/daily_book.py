"""Daily book items: days left unlocked, money due back."""
from __future__ import annotations

from datetime import date, timedelta
from typing import cast

from api.Modules.DailyBook.Models import DailyReport
from api.Modules.DailyBook.Services.settlements import list_open_settlements
from api.Modules.Notifications.Services.bell.types import (
    BellContext, BellItem, BellSource,
)

# How many past store days the "not locked" item looks back over.
# Owner default, 2026-11-04.
UNLOCKED_LOOKBACK_DAYS = 7


def collect_unlocked(ctx: BellContext) -> list[BellItem]:
    """A past day of the last ``UNLOCKED_LOOKBACK_DAYS`` that has a
    daily book (a row exists only once something was saved on it)
    and is not locked. Today is left out — it is still being
    entered. A day nobody started never shows, so closed days do
    not nag."""
    start = ctx.today - timedelta(days=UNLOCKED_LOOKBACK_DAYS)
    days = [
        d for (d,) in ctx.db.query(DailyReport.report_date).filter(
            DailyReport.store_id == ctx.store_id,
            DailyReport.report_date >= start,
            DailyReport.report_date < ctx.today,
            DailyReport.locked_at.is_(None),
        ).order_by(DailyReport.report_date.asc())
    ]
    if not days:
        return []
    oldest = days[0]
    return [BellItem(
        key="daily_book.unlocked",
        kind="daily_book.unlocked",
        # Yesterday is today's job; anything older is late.
        urgency="overdue" if oldest < ctx.today - timedelta(days=1) else "due",
        count=len(days),
        day=oldest,
    )]


def collect_due_back(ctx: BellContext) -> list[BellItem]:
    """Cash lent out ("Expected back"), cash borrowed ("We pay this
    back") and checks on hold whose back-by date is today or
    earlier and that still have money outstanding. An entry with no
    date never shows — nobody said when it is due."""
    due = [
        o for o in list_open_settlements(ctx.db, ctx.store_id)
        if o.item.settle_by is not None and o.item.settle_by <= ctx.today
    ]
    if not due:
        return []
    oldest: date = min(cast(date, o.item.settle_by) for o in due)
    return [BellItem(
        key="daily_book.due_back",
        kind="daily_book.due_back",
        urgency="overdue" if oldest < ctx.today else "due",
        count=len(due),
        day=oldest,
        amount_cents=sum(o.outstanding_cents for o in due),
    )]


UNLOCKED = BellSource(
    kind="daily_book.unlocked",
    # Locking needs Edit on the book AND the lock switch — the same
    # pair the lock route checks.
    permissions=("daily_book.update", "day_lock.update"),
    collect=collect_unlocked,
)

DUE_BACK = BellSource(
    kind="daily_book.due_back",
    # The day page (/daily/edit) is where a return is recorded.
    permissions=("daily_book.update",),
    collect=collect_due_back,
)
