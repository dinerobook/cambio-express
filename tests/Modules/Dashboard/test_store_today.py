"""The dashboard's "today" is the store's calendar day.

The server runs on UTC: at 9:30pm in Chicago it is already the next
day there, so "Today's transfers" and the daily-book prompt pointed
at tomorrow. With a timezone saved, the store's own day is used; a
store with none keeps the server's day, as before.
"""
from datetime import date, datetime, timezone

import pytest

import api.Core.Clock as clock
from tests._app import db, db_session
from tests.conftest import (
    login_admin, make_employee_client, seed_transfer,
)


class _LateEveningInChicago(datetime):
    """02:30 UTC on Oct 10 = 21:30 on Oct 9 in Chicago."""
    FIXED = datetime(2026, 10, 10, 2, 30, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        return cls.FIXED.astimezone(tz) if tz else cls.FIXED.replace(tzinfo=None)


@pytest.fixture
def late_evening(monkeypatch):
    monkeypatch.setattr(clock, "datetime", _LateEveningInChicago)


def _set_tz(store_id, tz):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        db.session.get(Store, store_id).timezone = tz
        db.session.commit()


def _summary(client, token):
    resp = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_admin_dashboard_uses_the_stores_day(
    client, test_store_id, test_admin_id, late_evening,
):
    _set_tz(test_store_id, "America/Chicago")
    seed_transfer(test_store_id, test_admin_id, send_date=date(2026, 10, 9))
    body = _summary(client, login_admin(client, test_store_id))
    assert body["today"] == "2026-10-09"
    assert body["kpis"]["today_transfers"] == 1


def test_store_without_a_timezone_keeps_the_server_day(
    client, test_store_id, test_admin_id, late_evening,
):
    _set_tz(test_store_id, "")
    seed_transfer(test_store_id, test_admin_id, send_date=date(2026, 10, 9))
    body = _summary(client, login_admin(client, test_store_id))
    assert body["today"] == "2026-10-10"
    assert body["kpis"]["today_transfers"] == 0


def test_employee_dashboard_uses_the_stores_day(
    client, test_store_id, late_evening,
):
    _set_tz(test_store_id, "America/Chicago")
    _emp, token = make_employee_client(test_store_id)
    body = _summary(client, token)
    assert body["today"] == "2026-10-09"
