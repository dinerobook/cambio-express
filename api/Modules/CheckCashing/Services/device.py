"""Check cashing — the one activated computer (owner, 2026-11-09).

Check cashing runs on one computer per store. An Admin activates it
on that computer; the browser then holds a random key in an httpOnly
cookie (``db_check_device_<store id>``, scoped to the check cashing
API) and only its sha256 is stored. Every check cashing route refuses
a request without the store's live key, so a password alone is not
enough to cash checks from elsewhere. Activating another computer
switches the old one off. Rules: ``INVARIANTS.md`` ("One computer").
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy.orm import Session

from api.Core.Clock import utc_now
from api.Modules.CheckCashing.Models import CheckDevice
from api.Modules.CheckCashing.Services import CheckCashingConflictError

COOKIE_PREFIX = "db_check_device_"
COOKIE_PATH = "/api/v2/check-cashing"
# The key lives as long as the computer stays activated; five years
# is just the browser's cap.
COOKIE_MAX_AGE = 5 * 365 * 24 * 3600
# ``last_seen_at`` is written at most this often (a read is not a write).
SEEN_EVERY = timedelta(minutes=10)
# Phones and tablets announce themselves with "Mobi" / "Android" /
# "iPad"; check cashing is desktop only.
MOBILE_MARKERS = ("mobi", "android", "iphone", "ipad")


def cookie_name(store_id: int) -> str:
    return f"{COOKIE_PREFIX}{store_id}"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def looks_mobile(user_agent: str) -> bool:
    ua = (user_agent or "").lower()
    return any(m in ua for m in MOBILE_MARKERS)


def active_device(db: Session, store_id: int) -> CheckDevice | None:
    return (
        db.query(CheckDevice)
        .filter(CheckDevice.store_id == store_id, CheckDevice.revoked_at.is_(None))
        .order_by(CheckDevice.id.desc())
        .first()
    )


@dataclass
class DeviceState:
    # this: the request comes from the activated computer;
    # other: another computer is activated; none: nothing activated.
    state: str
    device: CheckDevice | None


def device_state(db: Session, store_id: int, token: str | None) -> DeviceState:
    device = active_device(db, store_id)
    if device is None:
        return DeviceState("none", None)
    if token and secrets.compare_digest(device.token_hash, _hash(token)):
        return DeviceState("this", device)
    return DeviceState("other", device)


def touch(db: Session, device: CheckDevice) -> bool:
    """Note that the computer was used; True when a write is due."""
    now = utc_now()
    if device.last_seen_at is None or now - device.last_seen_at >= SEEN_EVERY:
        device.last_seen_at = now
        return True
    return False


def activate(
    db: Session, store_id: int, *, name: str, user_id: int, user_agent: str,
) -> tuple[CheckDevice, str, CheckDevice | None]:
    """Make this computer the store's check cashing computer. Returns
    the new row, the raw key for the cookie (never stored) and the
    computer it replaced, if any."""
    if looks_mobile(user_agent):
        raise CheckCashingConflictError(
            "Check cashing works on a desktop computer only. Activate it on the store PC.",
        )
    old = active_device(db, store_id)
    now = utc_now()
    if old is not None:
        old.revoked_at = now
        old.revoked_by = user_id
    token = secrets.token_urlsafe(32)
    row = CheckDevice(
        store_id=store_id, name=name.strip(), token_hash=_hash(token),
        created_by=user_id, created_at=now, last_seen_at=now,
    )
    db.add(row)
    db.flush()
    return row, token, old


def switch_off(db: Session, store_id: int, *, user_id: int) -> CheckDevice:
    """Switch check cashing off on the activated computer."""
    device = active_device(db, store_id)
    if device is None:
        raise CheckCashingConflictError("No computer is activated for check cashing.")
    device.revoked_at = utc_now()
    device.revoked_by = user_id
    db.flush()
    return device
