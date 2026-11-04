"""The top-bar notification bell — registry and the one reader.

How a bell answer is built (one request, ``GET /notifications/bell``):

  1. The store comes from the session, never the request. No store
     (superadmin, support, an owner at the umbrella) or the
     ``notification_bell`` flag off → ``enabled: false``, no items.
  2. Every source in ``SOURCES`` whose permissions, module and
     feature the person holds runs its ``collect`` inside a
     savepoint. A source that raises is logged to Sentry and
     skipped: the bell, and the page under it, carry on.
  3. Items the person dismissed for today's STORE day are dropped.
  4. What is left is sorted: overdue first, then oldest day.

Items are never stored. Only dismissals are
(``Models.BellDismissal``), and only for one store day.

Adding a kind of item: api/Modules/Notifications/CLAUDE.md "The bell".
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any, get_args

import sentry_sdk
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.Core.Clock import local_today, utc_now
from api.Modules.Notifications.Models import BellDismissal
from api.Modules.Notifications.Services.bell.sources import (
    bank, daily_book, return_checks,
)
from api.Modules.Notifications.Services.bell.types import (
    BellContext, BellItem, BellKind, BellSource,
)

_log = logging.getLogger(__name__)

FEATURE_FLAG = "notification_bell"

# Dismissals older than this are cleared store-wide on every new
# dismissal. They only ever hide an item for ONE day, so anything
# past yesterday is dead weight.
DISMISSAL_KEEP_DAYS = 30

# The registry. Order is the tie-break when two items share urgency
# and day. A new kind of item is a new source file plus one line
# here (and its row in frontend/src/lib/bellItems.ts).
SOURCES: tuple[BellSource, ...] = (
    daily_book.UNLOCKED,
    daily_book.DUE_BACK,
    bank.TO_CHECK,
    return_checks.PENDING,
)

ALL_KINDS: tuple[str, ...] = get_args(BellKind)


def bell_enabled(db: Session, store_id: int) -> bool:
    """The per-store switch. Opt-in: off until turned on."""
    from api.Modules.Billing.Services.feature_flags import opt_in_flag_enabled

    return opt_in_flag_enabled(db, store_id, FEATURE_FLAG)


def is_impersonating(claims: dict[str, Any]) -> bool:
    """A superadmin "Sign in as" session. It sees the bell the
    person sees but may not dismiss for them: hiding a reminder is
    that person's call."""
    return claims.get("impersonated_by") is not None


def _store_day(store: Any) -> date:
    return local_today(getattr(store, "timezone", None))


def _source_allowed(
    db: Session, claims: dict[str, Any], store: Any, user: Any,
    source: BellSource,
) -> bool:
    from api.Modules.Auth.Services.principal import has_permission
    from api.Modules.Billing.Services.feature_flags import (
        enabled_module_flags_for_user, store_feature_enabled,
    )

    for perm in source.permissions:
        resource, action = perm.split(".", 1)
        if not has_permission(claims, resource, action):
            return False
    if source.module is not None and source.module not in (
        enabled_module_flags_for_user(db, store, user)
    ):
        return False
    if source.feature is not None and not store_feature_enabled(
        db, store, source.feature,
    ):
        return False
    return True


def _run_source(source: BellSource, ctx: BellContext) -> list[BellItem]:
    """One source, fenced: a savepoint keeps a failed query from
    poisoning the transaction the next source reads through."""
    try:
        with ctx.db.begin_nested():
            items = source.collect(ctx)
    except Exception as exc:  # noqa: BLE001 — a broken source must not break the bell
        _log.exception("bell source %s failed for store %s",
                       source.kind, ctx.store_id)
        sentry_sdk.capture_exception(exc)
        return []
    # A source may only speak for its own kind.
    return [i for i in items if i.kind == source.kind]


def _dismissed_keys(
    db: Session, store_id: int, user_id: int, today: date,
) -> set[str]:
    return {
        key for (key,) in db.query(BellDismissal.item_key).filter(
            BellDismissal.store_id == store_id,
            BellDismissal.user_id == user_id,
            BellDismissal.dismissed_for == today,
        )
    }


def _sort_key(item: BellItem) -> tuple[int, date, int]:
    order = {s.kind: i for i, s in enumerate(SOURCES)}
    return (
        0 if item.urgency == "overdue" else 1,
        item.day or date.max,
        order.get(item.kind, len(order)),
    )


def build_bell(db: Session, claims: dict[str, Any]) -> dict[str, Any]:
    """The bell answer for the signed-in person (``BellResponse``)."""
    from api.Modules.Tenancy.Models import Store, User

    off: dict[str, Any] = {
        "enabled": False, "store_day": None, "can_dismiss": False,
        "items": [],
    }
    sid = claims.get("store_id")
    sub = claims.get("sub")
    if sid is None or sub is None:
        return off
    store = db.get(Store, int(sid))
    if store is None or not bell_enabled(db, int(sid)):
        return off
    user = db.get(User, int(sub))
    today = _store_day(store)
    ctx = BellContext(
        db=db, store_id=int(sid), user_id=int(sub), today=today,
        business_type=str(getattr(store, "business_type", "") or ""),
    )
    items: list[BellItem] = []
    for source in SOURCES:
        if _source_allowed(db, claims, store, user, source):
            items.extend(_run_source(source, ctx))
    hidden = _dismissed_keys(db, int(sid), int(sub), today)
    items = sorted(
        (i for i in items if i.key not in hidden), key=_sort_key,
    )
    return {
        "enabled": True,
        "store_day": today,
        "can_dismiss": not is_impersonating(claims),
        "items": items,
    }


def _check_key(key: str) -> str:
    """A key is ``<kind>`` or ``<kind>:<subject>`` for a known kind;
    anything else is refused so the table only ever holds keys the
    bell can send."""
    kind = key.split(":", 1)[0]
    if kind not in ALL_KINDS:
        raise HTTPException(status_code=422, detail="Unknown bell item.")
    return key


def _scope_for_write(
    db: Session, claims: dict[str, Any],
) -> tuple[int, int, date]:
    from api.Modules.Auth.Services.principal import resolve_store_scope
    from api.Modules.Tenancy.Models import Store

    sid = resolve_store_scope(claims)
    if is_impersonating(claims):
        raise HTTPException(
            status_code=403,
            detail="Only the person can dismiss their own reminders.",
        )
    if not bell_enabled(db, sid):
        raise HTTPException(
            status_code=404, detail="The bell is not on for this store.",
        )
    store = db.get(Store, sid)
    return sid, int(claims["sub"]), _store_day(store)


def dismiss(db: Session, claims: dict[str, Any], key: str) -> None:
    """Hide ``key`` for this person until the store's next day.
    Pressing it twice is a no-op."""
    key = _check_key(key)
    sid, uid, today = _scope_for_write(db, claims)
    db.query(BellDismissal).filter(
        BellDismissal.store_id == sid,
        BellDismissal.dismissed_for < today - timedelta(days=DISMISSAL_KEEP_DAYS),
    ).delete(synchronize_session=False)
    exists = db.query(BellDismissal.id).filter_by(
        store_id=sid, user_id=uid, item_key=key, dismissed_for=today,
    ).first()
    if exists is None:
        db.add(BellDismissal(
            store_id=sid, user_id=uid, item_key=key, dismissed_for=today,
            created_at=utc_now(),
        ))
    try:
        db.commit()
    except IntegrityError:
        # Two presses racing on two tabs: the other one saved it.
        db.rollback()


def undismiss(db: Session, claims: dict[str, Any], key: str) -> None:
    """Undo today's dismissal of ``key``. Nothing to undo is fine."""
    key = _check_key(key)
    sid, uid, today = _scope_for_write(db, claims)
    db.query(BellDismissal).filter_by(
        store_id=sid, user_id=uid, item_key=key, dismissed_for=today,
    ).delete(synchronize_session=False)
    db.commit()


__all__ = [
    "ALL_KINDS", "DISMISSAL_KEEP_DAYS", "FEATURE_FLAG", "SOURCES",
    "bell_enabled", "build_bell", "dismiss", "undismiss",
]
