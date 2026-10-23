"""Canonical UTC timestamp for the application.

Every call site that needs "now in UTC" — ORM column defaults,
services, scripts and tests — uses ``utc_now()``; nothing calls
``datetime.utcnow()`` (deprecated since Python 3.12).
``tests/Core/test_one_copy_helpers.py`` holds the line. Alembic
revisions are the one exception: they never import application code.

It returns a **naive** UTC datetime because every stored value in the
DB is naive UTC, and mixing aware with naive raises ``TypeError`` in
comparisons. When the DB layer is ready for aware timestamps, flip the
implementation here.
"""
from datetime import date, datetime, time, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException


def utc_now() -> datetime:
    """Return the current UTC time as a naive datetime."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def utc_from_timestamp(ts: float) -> datetime:
    """A Unix timestamp (Stripe, Financial Connections) as a naive UTC
    datetime — the replacement for the deprecated
    ``datetime.utcfromtimestamp``."""
    return datetime.fromtimestamp(ts, timezone.utc).replace(tzinfo=None)


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


def parse_iso_day(raw: str, *, field: str) -> date:
    """A ``YYYY-MM-DD`` path/query/body value as a ``date``, or a 422
    naming the field. The one parser every store-day route uses —
    DailyBook, Catalog, Lottery, DayClose and StoreBook each used to
    carry a private copy with its own error text. The detail is the
    ``{field, message}`` shape the SPA's ``apiErrorMessage`` reads."""
    try:
        return datetime.strptime(str(raw), "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={"field": field, "message": f"{field}: use YYYY-MM-DD."},
        )


def resolve_period(
    raw_from: str | None, raw_to: str | None, *, today: date,
) -> tuple[date, date]:
    """A report's ``from`` / ``to`` query values as a date range.

    Blank or unreadable ``from`` → the first of ``today``'s month;
    blank or unreadable ``to`` → ``today``; a backwards range is
    swapped rather than answered empty. Lenient on purpose — a
    report page with a mistyped date shows this month, it doesn't
    error. ``today`` is the store's day (``store_local_today``) for
    store reports, the server's for platform-wide ones. The one
    copy the report endpoints, the CSV export and the superadmin
    reports share."""
    def parse(raw: str | None, default: date) -> date:
        text = (raw or "").strip()
        if not text:
            return default
        try:
            return datetime.strptime(text, "%Y-%m-%d").date()
        except ValueError:
            return default

    d_from = parse(raw_from, date(today.year, today.month, 1))
    d_to = parse(raw_to, today)
    if d_from > d_to:
        d_from, d_to = d_to, d_from
    return d_from, d_to


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


def store_local_today(db: Any, store_id: int | None) -> date:
    """``local_today`` for a store by id — the store's own calendar
    day. A missing store, or one with no timezone saved, reads the
    server's UTC day, exactly what it got before stores had zones.
    For a route that already holds the ``Store`` row, call
    ``local_today(store.timezone)`` directly."""
    timezone: str | None = None
    if store_id:
        from api.Modules.Tenancy.Models import Store
        store = db.get(Store, int(store_id))
        timezone = store.timezone if store is not None else None
    return local_today(timezone)


def local_day_start_utc(day: date, timezone: str | None) -> datetime:
    """Naive-UTC instant at which ``day`` begins in ``timezone``.

    The storage twin of ``local_today``: timestamps are stored as
    naive UTC, so a store-local day ``D`` is the half-open window
    ``[local_day_start_utc(D, tz), local_day_start_utc(D + 1, tz))``.
    ``datetime.combine(D, time.min)`` is the UTC day, which starts
    five or six hours early for a US store and drops its evening.
    Blank or unknown zones read UTC — the window a store that never
    set a timezone always had."""
    local_midnight = datetime.combine(day, time.min, tzinfo=_zone(timezone))
    return local_midnight.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


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
