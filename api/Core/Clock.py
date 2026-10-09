"""Canonical UTC timestamp for the application.

Every runtime call site that needs "now in UTC" should use
``utc_now()`` instead of ``datetime.utcnow()``.

``datetime.utcnow()`` is deprecated in Python 3.12 (PEP 615) because
it returns a *naive* datetime that callers silently compare against
timezone-aware values — a class of bug that's hard to catch in
review.  This helper centralizes the call so a future migration to
``datetime.now(timezone.utc)`` (timezone-aware) only touches one
line.

For now we still return a **naive** datetime because the ORM column
defaults (``Column(DateTime, default=datetime.utcnow)``) and every
stored value in the DB are naive UTC.  Mixing aware + naive in
comparisons would raise ``TypeError`` at runtime.  When the DB layer
is ready for aware timestamps, flip the implementation here.
"""
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def utc_now() -> datetime:
    """Return the current UTC time as a naive datetime."""
    return datetime.utcnow()


# Canonical IANA timezone list — the dropdown options for both the
# personal-profile and store-settings forms. Single source so the
# two pickers can never drift.
TIMEZONE_CHOICES: tuple[str, ...] = (
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Phoenix",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
    "America/Mexico_City",
    "America/Bogota",
    "America/Lima",
    "America/Santiago",
    "America/Buenos_Aires",
    "America/Sao_Paulo",
    "Europe/London",
    "Europe/Madrid",
    "Asia/Manila",
    "Asia/Karachi",
    "UTC",
)


def iso(dt: "datetime | None") -> str:
    """ISO-8601 string for a nullable datetime — "" when None.
    The response-serialization twin of ``utc_now()``: four
    controllers used to declare an identical private ``_iso``;
    this is the single shared copy."""
    return dt.isoformat() if dt else ""


def iso_or_none(dt: object) -> str | None:
    """Like ``iso`` but None-preserving, and tolerant of values
    that are already strings (some export paths carry mixed
    types). Used where the JSON field is nullable."""
    if dt is None:
        return None
    if hasattr(dt, "isoformat"):
        return dt.isoformat()  # type: ignore[attr-defined]
    return str(dt)


def _zone(name: str | None) -> ZoneInfo:
    """ZoneInfo for an IANA name; blank or unknown names are UTC."""
    try:
        return ZoneInfo((name or "").strip() or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def local_now(timezone: str | None) -> datetime:
    """Wall-clock time now in ``timezone`` (naive). Blank or unknown
    zones read UTC — the server's clock, so a store that never set a
    timezone keeps exactly the behaviour it had."""
    return datetime.now(tz=_zone(timezone)).replace(tzinfo=None)


def local_today(timezone: str | None) -> date:
    """Today's calendar day in ``timezone``. Use with the store's
    ``Store.timezone`` wherever a store-scoped route means "today" —
    ``date.today()`` reads the server's UTC day, which is already
    tomorrow for a US store after about 7pm."""
    return local_now(timezone).date()


def display_timezone(store: Any, user: Any) -> str:
    """The zone the SPA renders every date and time in: the store's
    (Settings → General), else the person's own (store-less
    principals), else "" (the device's zone). Unknown names are
    skipped so a bad value never reaches ``Intl``."""
    for owner in (store, user):
        name = str(getattr(owner, "timezone", "") or "").strip()
        if not name:
            continue
        try:
            ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            continue
        return name
    return ""
