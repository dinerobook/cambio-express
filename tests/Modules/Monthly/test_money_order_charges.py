"""Money order fees on the Monthly P&L, net of the company's charge.

Owner's rule (2026-10-20): what the store charges on top of a money
order is its own; the company takes the face value plus its own
per-order charge (e.g. $0.30) from the bank. So:

* the daily book's Money orders tab takes a count per company
  (`msb_mt_service.item_count`, optional);
* Settings → Money services takes each company's charge per money
  order (`tenancy_store.money_order_charges`, optional);
* the P&L's money order fees = fees − Σ count × charge per company.

Both new fields are optional and NULL by default, so a store that
fills in neither reads exactly as before.
"""
from datetime import date

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client

Y, M = 2026, 9
DAY = date(Y, M, 10)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def admin(client, test_store_id):
    return _h(login_admin(client, test_store_id))


def _roster(*companies):
    return {"mt_companies": [dict(c) for c in companies]}


def _save_day(client, sid, admin, services, d=DAY):
    return client.put(
        f"/api/v2/daily/{sid}/{d.isoformat()}/mt-breakdown",
        json={"rows": [], "services": services}, headers=admin,
    )


def _pl(client, sid, admin):
    return client.get(f"/api/v2/monthly/{Y}/{M}", headers=admin).get_json()["report"]


# ── Settings: the per-company charge ────────────────────────


def test_settings_save_and_read_a_charge_per_money_order(client, admin):
    resp = client.put("/api/v2/admin/store-info", headers=admin, json=_roster(
        {"name": "Intermex", "enabled": True, "money_orders": True,
         "money_order_charge": 0.30},
        {"name": "Maxi", "enabled": True, "money_orders": True},
    ))
    assert resp.status_code == 200, resp.text
    roster = {c["name"]: c for c in resp.get_json()["store"]["mt_companies"]}
    assert roster["Intermex"]["money_order_charge"] == 0.30
    assert roster["Maxi"]["money_order_charge"] == 0.0


def test_a_save_without_the_charge_keeps_it_and_zero_clears_it(client, admin):
    client.put("/api/v2/admin/store-info", headers=admin, json=_roster(
        {"name": "Intermex", "money_order_charge": 0.30},
    ))
    # An older client that does not know the field must not wipe it.
    resp = client.put("/api/v2/admin/store-info", headers=admin, json=_roster(
        {"name": "Intermex", "enabled": True},
    ))
    assert resp.get_json()["store"]["mt_companies"][0]["money_order_charge"] == 0.30
    resp = client.put("/api/v2/admin/store-info", headers=admin, json=_roster(
        {"name": "Intermex", "money_order_charge": 0},
    ))
    assert resp.get_json()["store"]["mt_companies"][0]["money_order_charge"] == 0.0


def test_a_negative_charge_is_refused(client, admin):
    resp = client.put("/api/v2/admin/store-info", headers=admin, json=_roster(
        {"name": "Intermex", "money_order_charge": -1},
    ))
    assert resp.status_code == 422


def test_an_employee_cannot_set_charges(test_store_id):
    c, jwt = make_employee_client(test_store_id)
    resp = c.put("/api/v2/admin/store-info", headers=_h(jwt), json=_roster(
        {"name": "Intermex", "money_order_charge": 5},
    ))
    assert resp.status_code == 403


def test_charges_service_reads_bad_json_as_none():
    from types import SimpleNamespace
    from api.Modules.Transfers.Services import store_money_order_charges
    assert store_money_order_charges(SimpleNamespace(money_order_charges="{bad")) == {}
    assert store_money_order_charges(SimpleNamespace(money_order_charges=None)) == {}
    assert store_money_order_charges(
        SimpleNamespace(money_order_charges='{"Intermex": 0.3, "Maxi": "x"}'),
    ) == {"intermex": 0.3}


# ── Daily book: the count ───────────────────────────────────


def test_money_order_count_saves_and_reads_back(client, test_store_id, admin):
    resp = _save_day(client, test_store_id, admin, [
        {"company": "Intermex", "service": "money_order",
         "amount": 500.0, "fees": 10.0, "count": 5},
    ])
    assert resp.status_code == 200, resp.text
    body = client.get(
        f"/api/v2/daily/{test_store_id}/{DAY.isoformat()}/mt-breakdown",
        headers=admin,
    ).get_json()
    assert body["services"] == [{
        "company": "Intermex", "service": "money_order",
        "amount": 500.0, "fees": 10.0, "count": 5,
    }]
    # The count is not money: the day's total is amount + fee only.
    assert body["saved_total"] == 510.0


def test_a_negative_count_is_refused(client, test_store_id, admin):
    resp = _save_day(client, test_store_id, admin, [
        {"company": "Intermex", "service": "money_order",
         "amount": 500.0, "fees": 10.0, "count": -1},
    ])
    assert resp.status_code == 422


def test_a_service_row_without_a_count_stores_null(client, test_store_id, admin):
    from api.Modules.DailyBook.Models import MoneyServiceSummary
    _save_day(client, test_store_id, admin, [
        {"company": "Intermex", "service": "money_order",
         "amount": 100.0, "fees": 2.0},
    ])
    with db_session():
        row = db.session.query(MoneyServiceSummary).one()
        assert row.item_count is None


def test_the_count_cannot_be_saved_on_a_locked_day(client, test_store_id, admin):
    from api.Core.Clock import utc_now
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        db.session.add(DailyReport(store_id=test_store_id, report_date=DAY,
                                   locked_at=utc_now()))
        db.session.commit()
    resp = _save_day(client, test_store_id, admin, [
        {"company": "Intermex", "service": "money_order",
         "amount": 100.0, "fees": 2.0, "count": 1},
    ])
    assert resp.status_code == 403


# ── The P&L line ────────────────────────────────────────────


def test_pl_takes_count_times_charge_off_the_fees(client, test_store_id, admin):
    client.put("/api/v2/admin/store-info", headers=admin, json=_roster(
        {"name": "Intermex", "money_order_charge": 0.30},
        {"name": "Maxi", "money_order_charge": 0.50},
        {"name": "Barri"},
    ))
    _save_day(client, test_store_id, admin, [
        {"company": "Intermex", "service": "money_order",
         "amount": 1000.0, "fees": 20.0, "count": 10},
        {"company": "Maxi", "service": "money_order",
         "amount": 400.0, "fees": 8.0, "count": 4},
        # No charge set for Barri: nothing comes off its fees.
        {"company": "Barri", "service": "money_order",
         "amount": 100.0, "fees": 2.0, "count": 1},
    ])
    _save_day(client, test_store_id, admin, [
        {"company": "Intermex", "service": "money_order",
         "amount": 200.0, "fees": 4.0, "count": 2},
    ], d=date(Y, M, 11))

    r = _pl(client, test_store_id, admin)

    fees = 20 + 8 + 2 + 4
    charges = 12 * 0.30 + 4 * 0.50
    assert r["money_order_count"] == 17
    assert r["money_order_charges"] == round(charges, 2)
    assert r["money_order_fees"] == round(fees - charges, 2)
    assert r["total_income"] == round(fees - charges, 2)


def test_no_count_or_no_charge_leaves_the_fees_whole(client, test_store_id, admin):
    client.put("/api/v2/admin/store-info", headers=admin, json=_roster(
        {"name": "Intermex", "money_order_charge": 0.30},
    ))
    _save_day(client, test_store_id, admin, [
        {"company": "Intermex", "service": "money_order",
         "amount": 1000.0, "fees": 20.0},
    ])
    r = _pl(client, test_store_id, admin)
    assert r["money_order_fees"] == 20.0
    assert r["money_order_charges"] == 0.0
