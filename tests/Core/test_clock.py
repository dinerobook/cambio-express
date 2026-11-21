"""Store-local clock helpers in ``api.Core.Clock``.

The server runs on UTC, so ``date.today()`` is already tomorrow for
a US store after about 7pm. Store-scoped routes read "today" through
``local_today(store.timezone)``; the SPA renders every time in the
zone ``display_timezone`` picks.
"""
from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest

import api.Core.Clock as clock


class _FrozenDatetime(datetime):
    """``datetime`` whose ``now(tz)`` is pinned to 02:30 UTC, Oct 10."""
    FIXED = datetime(2026, 10, 10, 2, 30, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        return cls.FIXED.astimezone(tz) if tz else cls.FIXED.replace(tzinfo=None)


@pytest.fixture
def frozen(monkeypatch):
    monkeypatch.setattr(clock, "datetime", _FrozenDatetime)


def test_local_today_is_the_stores_day(frozen):
    # 02:30 UTC on Oct 10 is 21:30 on Oct 9 in Chicago.
    assert clock.local_today("America/Chicago") == date(2026, 10, 9)
    assert clock.local_today("Asia/Manila") == date(2026, 10, 10)


def test_local_now_is_the_wall_clock(frozen):
    now = clock.local_now("America/Los_Angeles")
    assert (now.month, now.day, now.hour, now.minute) == (10, 9, 19, 30)
    assert now.tzinfo is None


@pytest.mark.parametrize("tz", ["", None, "   ", "Not/AZone"])
def test_blank_or_unknown_zone_keeps_the_utc_day(frozen, tz):
    # A store that never set a timezone sees exactly what it saw
    # before: the server's (UTC) day.
    assert clock.local_today(tz) == date(2026, 10, 10)


def _row(tz):
    return SimpleNamespace(timezone=tz)


def test_display_timezone_prefers_the_store():
    assert clock.display_timezone(
        _row("America/Chicago"), _row("America/New_York"),
    ) == "America/Chicago"


def test_display_timezone_falls_back_to_the_person():
    # Superadmin / owner portfolio: no store in scope.
    assert clock.display_timezone(None, _row("America/Denver")) == "America/Denver"
    assert clock.display_timezone(_row(""), _row("America/Denver")) == "America/Denver"


def test_display_timezone_skips_unknown_names():
    assert clock.display_timezone(_row("Mars/Base"), _row("")) == ""
    assert clock.display_timezone(_row("Mars/Base"), _row("UTC")) == "UTC"
    assert clock.display_timezone(None, None) == ""


# ── local_to_utc: a store device's wall clock as naive UTC ──


def test_local_to_utc_reads_the_wall_clock_in_the_zone():
    # 2:02 PM in Texas on the day clocks spring forward is CDT (UTC-5);
    # in January it is CST (UTC-6).
    assert clock.local_to_utc(
        datetime(2026, 3, 8, 14, 2, 3), "America/Chicago",
    ) == datetime(2026, 3, 8, 19, 2, 3)
    assert clock.local_to_utc(
        datetime(2026, 1, 15, 14, 2, 3), "America/Chicago",
    ) == datetime(2026, 1, 15, 20, 2, 3)


@pytest.mark.parametrize("tz", ["", None, "Mars/Base"])
def test_local_to_utc_leaves_the_time_alone_without_a_zone(tz):
    assert clock.local_to_utc(datetime(2026, 3, 8, 14, 2, 3), tz) == datetime(
        2026, 3, 8, 14, 2, 3,
    )


def test_local_to_utc_passes_none_through():
    assert clock.local_to_utc(None, "America/Chicago") is None
