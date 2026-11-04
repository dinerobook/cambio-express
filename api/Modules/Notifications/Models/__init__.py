"""Notifications — Models.

``BellDismissal`` — one row per "Dismiss" a person pressed on a
top-bar bell item. The bell's items themselves are never stored:
each is worked out live from the books on every request
(``Services/bell``), so an item disappears the moment its work is
done and nothing can go stale. Only the dismissal is remembered,
and only for the store day it was made on: tomorrow the item comes
back if it is still true.

``user_id`` is deliberately NOT a foreign key. An owner dismisses
items in a store their ``User`` row does not belong to, and an
employee can be deleted while their dismissals are still on file;
neither may be blocked by a row that only ever hides a reminder.
Rows older than ``DISMISSAL_KEEP_DAYS`` are cleared store-wide on
every new dismissal, so the table stays tiny without a scheduled
job. Migration ``c9d4e7a2f1b6``.
"""
from __future__ import annotations

from sqlalchemy import (
    Column, Date, DateTime, ForeignKey, Index, Integer, String,
    UniqueConstraint,
)

from api.Core.Clock import utc_now
from api.Core.Database import Base


class BellDismissal(Base):
    __tablename__ = "notify_bell_dismissal"
    id            = Column(Integer, primary_key=True)
    store_id      = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False)
    user_id       = Column(Integer, nullable=False)
    # The bell item's stable key (``BellItem.key``), e.g.
    # ``daily_book.unlocked``. Never renamed once live.
    item_key      = Column(String(120), nullable=False)
    # The STORE's calendar day the dismissal holds for.
    dismissed_for = Column(Date, nullable=False)
    created_at    = Column(DateTime, default=utc_now)
    __table_args__ = (
        UniqueConstraint(
            "store_id", "user_id", "item_key", "dismissed_for",
            name="uq_notify_bell_dismissal",
        ),
        Index(
            "ix_notify_bell_dismissal_store_user_day",
            "store_id", "user_id", "dismissed_for",
        ),
    )


__all__ = ["BellDismissal"]
