"""``api.Core.Clock.parse_iso_day`` — the one YYYY-MM-DD parser the
store-day routes share (DailyBook, Catalog, Lottery, DayClose,
StoreBook each used to carry a private copy with its own 422 text).

The 422 detail is ``{"field", "message"}``; the SPA's
``apiErrorMessage`` reads either that or a plain string.
"""
from datetime import date

import pytest
from fastapi import HTTPException

from api.Core.Clock import parse_iso_day
from tests.conftest import login_admin


# ── unit ────────────────────────────────────────────────────


def test_parses_a_calendar_day():
    assert parse_iso_day("2026-08-02", field="day") == date(2026, 8, 2)


def test_leap_day_is_a_day():
    assert parse_iso_day("2028-02-29", field="day") == date(2028, 2, 29)


@pytest.mark.parametrize("raw", [
    "", "not-a-date", "08/02/2026", "2026-13-01", "2026-02-30",
    "2026-08-02T10:00", "20260802x",
])
def test_bad_values_are_422_naming_the_field(raw):
    with pytest.raises(HTTPException) as exc:
        parse_iso_day(raw, field="report_date")
    assert exc.value.status_code == 422
    assert exc.value.detail == {
        "field": "report_date",
        "message": "report_date: use YYYY-MM-DD.",
    }


# ── routes: one bad date per module that uses it ────────────


def _h(client, store_id):
    return {"Authorization": f"Bearer {login_admin(client, store_id)}"}


def _assert_detail(resp, field):
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == {
        "field": field, "message": f"{field}: use YYYY-MM-DD.",
    }


def test_dailybook_bad_report_date(client, test_store_id):
    resp = client.get(
        f"/api/v2/daily/{test_store_id}/not-a-date",
        headers=_h(client, test_store_id),
    )
    _assert_detail(resp, "report_date")


def test_dailybook_bad_period_bound(client, test_store_id):
    resp = client.get(
        f"/api/v2/daily/{test_store_id}/period?from=2026-05-01&to=2026-05-6x",
        headers=_h(client, test_store_id),
    )
    _assert_detail(resp, "to")


def test_lottery_bad_day(client, test_store_id):
    resp = client.get(
        "/api/v2/lottery/day/2026-13-45", headers=_h(client, test_store_id),
    )
    _assert_detail(resp, "day")


def test_dayclose_bad_day(client, test_store_id):
    resp = client.get(
        "/api/v2/dayclose/day/2026-02-30", headers=_h(client, test_store_id),
    )
    _assert_detail(resp, "day")


def test_storebook_bad_day(client, test_store_id):
    resp = client.get(
        "/api/v2/storebook/not-a-date", headers=_h(client, test_store_id),
    )
    _assert_detail(resp, "day")


def test_catalog_bad_invoice_date(client, test_store_id):
    h = _h(client, test_store_id)
    vendor = client.post(
        "/api/v2/catalog/vendors", headers=h, json={"name": "Date Vendor"},
    ).json()["vendor"]
    resp = client.post("/api/v2/catalog/invoices", headers=h, json={
        "vendor_id": vendor["id"], "invoice_number": "INV-1",
        "invoice_date": "08/20/2026",
    })
    _assert_detail(resp, "invoice_date")


def test_good_day_still_answers(client, test_store_id):
    """The success path is untouched: a valid day reads."""
    resp = client.get(
        "/api/v2/storebook/2026-08-02", headers=_h(client, test_store_id),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["entry_date"] == "2026-08-02"


def test_bad_day_without_a_token_is_401(client):
    """No token → 401, whatever the date looks like: parsing never
    runs ahead of authentication."""
    assert client.get("/api/v2/storebook/not-a-date").status_code == 401
