"""Setup progress per store (superadmin, Platform → Setup progress).

Grant: the superadmin reads every store's four setup steps. Deny: a
stranger, a store admin, an employee and an owner all get turned
away. Success / failure: each step flips on exactly the data it reads,
steps that do not apply drop out of the count, and the open / done
filter and the search narrow the list.
"""
import json
from urllib.parse import urlencode
from datetime import date, datetime, timedelta

import pytest

from api.Core.Clock import utc_now
from tests._app import db, db_session
from tests.conftest import (
    login_admin, login_superadmin, make_employee_client, owner_token_for,
)

URL = "/api/v2/superadmin/setup-progress"


@pytest.fixture
def h(client):
    return {"Authorization": f"Bearer {login_superadmin(client)}"}


def _store(slug, *, business_type="msb_hybrid", **kw):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = Store(name=slug.title(), slug=slug, plan="trial",
                  business_type=business_type, **kw)
        db.session.add(s)
        db.session.commit()
        return s.id


def _bank(store_id, *, disconnected=False, acct="fca_1"):
    from api.Modules.BankSync.Models import StripeBankAccount
    with db_session():
        db.session.add(StripeBankAccount(
            store_id=store_id, stripe_account_id=acct, last4="1234",
            disconnected_at=utc_now() if disconnected else None,
        ))
        db.session.commit()


def _day(store_id, day, *, locked):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        db.session.add(DailyReport(
            store_id=store_id, report_date=day,
            locked_at=utc_now() if locked else None,
        ))
        db.session.commit()


def _rows(client, h, **params):
    params.setdefault("status", "all")
    resp = client.get(f"{URL}?{urlencode(params)}", headers=h)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _row(client, h, slug):
    data = _rows(client, h, q=slug)
    return next(r for r in data["rows"] if r["slug"] == slug)


# ── Deny ─────────────────────────────────────────────────────────


def test_stranger_is_401(client):
    assert client.get(URL).status_code == 401


def test_store_admin_is_403(client, test_store_id):
    tok = login_admin(client, test_store_id)
    resp = client.get(URL, headers={"Authorization": f"Bearer {tok}"})
    assert resp.status_code == 403


def test_employee_is_403(test_store_id):
    c, tok = make_employee_client(test_store_id)
    resp = c.get(URL, headers={"Authorization": f"Bearer {tok}"})
    assert resp.status_code == 403


def test_owner_is_403(client, test_store_id):
    tok = owner_token_for([test_store_id])
    resp = client.get(URL, headers={"Authorization": f"Bearer {tok}"})
    assert resp.status_code == 403


def test_bad_status_is_422(client, h):
    assert client.get(f"{URL}?status=x", headers=h).status_code == 422


# ── Grant + each step ────────────────────────────────────────────


def test_fresh_msb_store_has_nothing_done(client, h):
    _store("fresh")
    row = _row(client, h, "fresh")
    assert row["companies_added"] is False
    assert row["company_count"] == 0
    # Built-in roster: all three default companies sell money orders.
    assert row["charges_set"] is False
    assert row["money_order_companies"] == 3
    assert row["money_order_charges_set"] == 0
    assert row["bank_connected"] is False
    assert row["first_locked_day"] is None
    assert (row["steps_done"], row["steps_total"]) == (0, 4)


def test_fully_set_up_store(client, h):
    sid = _store(
        "ready", companies="Intermex,Maxi",
        money_order_charges=json.dumps({"Intermex": 0.5, "maxi": 0.25}),
    )
    _bank(sid)
    _day(sid, date(2026, 10, 3), locked=False)
    _day(sid, date(2026, 10, 2), locked=True)
    _day(sid, date(2026, 10, 1), locked=True)
    row = _row(client, h, "ready")
    assert row["companies_added"] is True
    assert row["company_count"] == 2
    assert row["charges_set"] is True
    assert row["money_order_charges_set"] == 2
    assert row["bank_connected"] is True
    assert row["first_locked_day"] == "2026-10-01"
    assert (row["steps_done"], row["steps_total"]) == (4, 4)


def test_partial_charges_are_not_done(client, h):
    _store("half", companies="Intermex,Maxi",
           money_order_charges=json.dumps({"Intermex": 0.5}))
    row = _row(client, h, "half")
    assert row["charges_set"] is False
    assert (row["money_order_companies"], row["money_order_charges_set"]) == (2, 1)


def test_disabled_company_and_money_orders_off_are_not_counted(client, h):
    _store("mixed", companies="Intermex,Maxi,Barri",
           companies_disabled="Barri", companies_money_orders_off="Maxi",
           money_order_charges=json.dumps({"Intermex": 1}))
    row = _row(client, h, "mixed")
    assert row["company_count"] == 2
    assert row["money_order_companies"] == 1
    assert row["charges_set"] is True


def test_no_money_order_company_drops_the_charge_step(client, h):
    _store("nomo", companies="Intermex", companies_money_orders_off="Intermex")
    row = _row(client, h, "nomo")
    assert row["charges_set"] is None
    assert row["steps_total"] == 3


def test_disconnected_bank_does_not_count(client, h):
    sid = _store("gonebank")
    _bank(sid, disconnected=True)
    assert _row(client, h, "gonebank")["bank_connected"] is False


def test_unlocked_day_does_not_count(client, h):
    sid = _store("draft")
    _day(sid, date(2026, 10, 1), locked=False)
    assert _row(client, h, "draft")["first_locked_day"] is None


def test_retail_store_skips_money_service_steps(client, h):
    _store("shop", business_type="cstore")
    row = _row(client, h, "shop")
    assert row["companies_added"] is None
    assert row["charges_set"] is None
    assert row["steps_total"] == 2


def test_money_services_override_brings_steps_back(client, h):
    from api.Modules.Billing.Models import StoreFeatureOverride
    sid = _store("shopmsb", business_type="cstore")
    with db_session():
        db.session.add(StoreFeatureOverride(
            store_id=sid, flag_key="module_money_services", enabled=True,
        ))
        db.session.commit()
    row = _row(client, h, "shopmsb")
    assert row["companies_added"] is False
    assert row["steps_total"] == 4


def test_sign_up_day_is_the_store_local_day(client, h):
    # 03:00 UTC on Nov 2 is still Nov 1 in Chicago.
    _store("chi", timezone="America/Chicago",
           created_at=datetime(2026, 11, 2, 3, 0))
    row = _row(client, h, "chi")
    assert row["signed_up_on"] == "2026-11-01"
    assert row["days_since_signup"] >= 0


# ── Filter, search, paging ───────────────────────────────────────


def test_open_is_the_default_and_hides_finished_stores(client, h):
    sid = _store("donestore", business_type="cstore")
    _bank(sid)
    _day(sid, date(2026, 10, 1), locked=True)
    _store("stuckstore")
    slugs = {r["slug"] for r in client.get(URL, headers=h).json()["rows"]}
    assert "stuckstore" in slugs and "donestore" not in slugs
    done = {r["slug"] for r in _rows(client, h, status="done")["rows"]}
    assert done == {"donestore"}


def test_search_and_paging(client, h):
    for i in range(3):
        _store(f"page-{i}")
    data = _rows(client, h, q="page-", per_page=2)
    assert (data["total"], data["total_pages"], len(data["rows"])) == (3, 2, 2)
    second = _rows(client, h, q="page-", per_page=2, page=2)
    assert len(second["rows"]) == 1


def test_newest_store_first(client, h):
    now = utc_now()
    _store("older", created_at=now - timedelta(days=5))
    _store("newer", created_at=now)
    slugs = [r["slug"] for r in _rows(client, h, q="er")["rows"]]
    assert slugs.index("newer") < slugs.index("older")


def test_batched_flags_agree_with_single_store_lookup():
    from api.Core.Bootstrap import seed_feature_flags
    from api.Modules.Billing.Services.feature_flags import (
        store_feature_enabled, stores_feature_enabled,
    )
    from api.Modules.Tenancy.Models import Store
    _store("b-msb")
    _store("b-shop", business_type="cstore")
    with db_session():
        seed_feature_flags(db.session)
        stores = db.session.query(Store).all()
        for key in ("module_money_services", "module_lottery", "no_such_flag"):
            batch = stores_feature_enabled(db.session, stores, key)
            for s in stores:
                assert batch[s.id] == store_feature_enabled(db.session, s, key)
        assert stores_feature_enabled(db.session, [], "module_lottery") == {}
