"""Shapes shared by the bell registry, its sources and its route.

``BellKind`` is the closed list of item kinds the server can send.
It is a ``Literal`` so the generated OpenAPI types carry it as a
union: the SPA's item table (``frontend/src/lib/bellItems.ts``) is a
``Record<BellKind, …>``, and a kind added here without its row
there fails ``npm run build``. A kind is never renamed once live —
saved dismissals point at it.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Callable, Literal

from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

BellKind = Literal[
    "daily_book.unlocked",
    "daily_book.due_back",
    "bank.to_check",
    "return_checks.pending",
]

# ``overdue`` sorts first and shows the warning tone; ``due`` is
# today's work.
BellUrgency = Literal["overdue", "due"]


class BellItem(BaseModel):
    """One row in the bell's list. Words, icon and link are the
    SPA's job (``bellItems.ts``); the server sends only what the
    sentence needs."""

    model_config = ConfigDict(extra="forbid")

    # Stable id of what the item is about. A dismissal points at it.
    key: str
    kind: BellKind
    urgency: BellUrgency
    # How many things the item groups (days, rows, checks).
    count: int
    # The day the item is about — the oldest one when it groups
    # several. Store calendar day.
    day: date | None = None
    # Money the item is about, in cents, when it has one.
    amount_cents: int | None = None
    # Which filtered view the link opens, for kinds with more than
    # one (``bank.to_check``: ``review`` or ``uncategorized``).
    view: str | None = None


@dataclass(frozen=True)
class BellContext:
    """What a source gets: the session, the store and its day."""

    db: Session
    store_id: int
    user_id: int
    # The store's own calendar day (its timezone), never the server's.
    today: date
    # The store's business type, for sources that only fit some.
    business_type: str


@dataclass(frozen=True)
class BellSource:
    """One kind of bell item. See api/Modules/Notifications/CLAUDE.md
    "The bell" for the rules every source follows."""

    kind: BellKind
    # Every "resource.action" the person must hold (live check).
    # At least one — the registry test refuses a source without.
    permissions: tuple[str, ...]
    # Reads the books and returns zero or more items. Read-only.
    collect: Callable[[BellContext], list[BellItem]]
    # Store module (``module_*``) the item lives in, checked against
    # the store AND the person's own module access, like the nav.
    module: str | None = None
    # Store feature flag the item needs (``store_feature_enabled``).
    feature: str | None = None
