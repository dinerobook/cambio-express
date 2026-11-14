"""Check cashing module, PR 5b: the checks list filters and the period
report — api/Modules/CheckCashing/INVARIANTS.md ("Checks and reports").

The rules under test:
  * GET /checks filters by a store-day range and searches customer,
    company or check number (two characters at least);
  * GET /report totals cashed / declined / voided checks, fees and cash
    for a period, each store and each day, the top companies and
    customers, and where bad checks stand;
  * the report is view only and opens on ANY device (no activated
    computer needed), for Admins, cashiers with the read right and
    owners signed in without a store (their stores with check cashing
    on); one store can be picked, only one of the caller's;
  * the module switch, the read right and the Accountant refusal hold;
    unrelated stores never show.
"""
from datetime import date, timedelta

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee, login_owner
from tests.Modules.CheckCashing.test_bad_checks import _pay, _report  # noqa: F401
from tests.Modules.CheckCashing.test_cash_a_check import (  # noqa: F401
    CHECKS, _cash, _settings, party,
)
from tests.Modules.CheckCashing.test_check_cashing import (  # noqa: F401
    BASE, _activate, _employee, _flag, _h, _link_owner, _mk_company,
    _mk_customer, _new_store, admin, cashier, on,
)

REPORT = f"{BASE}/report"
TODAY = date.today()


def _move_day(check_id, days_back):
    from api.Modules.CheckCashing.Models import CashedCheck
    with db_session():
        db.session.get(CashedCheck, check_id).store_day = TODAY - timedelta(days=days_back)
        db.session.commit()


@pytest.fixture
def activity(client, admin, party):
    """Three cashed checks (one yesterday), one not accepted, one
    voided, one bad check with a payment."""
    cust, comp = party
    other = _mk_customer(client, admin, "Bea Diaz")
    first = _cash(client, admin, cust, comp, amount=500, check_number="1").json()["check"]
    _cash(client, admin, other, comp, amount=300, check_number="2")
    old = _cash(client, admin, other, comp, amount=200, check_number="3",
                ack=["cashed_today"]).json()["check"]
    _move_day(old["id"], 1)
    _cash(client, admin, cust, comp, decision="decline", reason="Altered")
    gone = _cash(client, admin, cust, comp, amount=50, check_number="4",
                 ack=["cashed_today"]).json()["check"]
    assert client.post(f"{CHECKS}/{gone['id']}/void", headers=admin,
                       json={"reason": "x"}).status_code == 200
    bad = _report(client, admin, first["id"]).json()["bad_check"]
    _pay(client, admin, bad["id"], 100)
    return cust, comp, other


class TestChecksList:
    def test_day_range_and_search(self, client, admin, activity):
        _cust, _comp, _other = activity
        today = TODAY.isoformat()
        rows = client.get(f"{CHECKS}?from={today}&to={today}", headers=admin).json()
        assert rows["total"] == 4
        older = client.get(
            f"{CHECKS}?to={(TODAY - timedelta(days=1)).isoformat()}", headers=admin,
        ).json()
        assert [r["check_number"] for r in older["rows"]] == ["3"]
        bea = client.get(f"{CHECKS}?q=bea", headers=admin).json()
        assert sorted(r["check_number"] for r in bea["rows"]) == ["2", "3"]
        by_number = client.get(f"{CHECKS}?q=3&status=cashed", headers=admin).json()
        assert by_number["total"] == 3  # one character: no search, cashed only
        company = client.get(f"{CHECKS}?q=electric", headers=admin).json()
        assert company["total"] == 5
        assert client.get(f"{CHECKS}?from=soon", headers=admin).status_code == 422


class TestReport:
    def test_totals_days_parties_and_bad_checks(self, client, admin, activity):
        r = client.get(REPORT, headers=admin)
        assert r.status_code == 200, r.text
        out = r.json()
        assert (out["from_day"], out["to_day"]) == (
            TODAY.replace(day=1).isoformat() if TODAY.day > 1 else TODAY.isoformat(),
            TODAY.isoformat())
        t = out["totals"]
        assert (t["cashed"], t["amount"], t["declined"], t["voided"]) == (3, 1000.0, 1, 1)
        assert t["fees"] == 20.0 and t["cash"] == 980.0
        assert t["average"] == 333.33
        assert [s["cashed"] for s in out["stores"]] == [3]
        assert [s["name"] for s in out["store_options"]] == [out["stores"][0]["store_name"]]
        today = next(d for d in out["days"] if d["day"] == TODAY.isoformat())
        assert (today["cashed"], today["amount"], today["voided"]) == (2, 800.0, 1)
        assert [c["name"] for c in out["companies"]] == ["PD Electric LLC"]
        assert [(c["name"], c["amount"]) for c in out["customers"]] == [
            ("Bea Diaz", 500.0), ("Ana Lopez", 500.0)] or [
            (c["name"], c["amount"]) for c in out["customers"]] == [
            ("Ana Lopez", 500.0), ("Bea Diaz", 500.0)]
        b = out["bad_checks"]
        assert (b["open_count"], b["open_owed"], b["returned"], b["returned_owed"],
                b["paid_back"]) == (1, 425.0, 1, 525.0, 100.0)

    def test_period(self, client, admin, activity):
        y = (TODAY - timedelta(days=1)).isoformat()
        out = client.get(f"{REPORT}?from={y}&to={y}", headers=admin).json()
        assert (out["totals"]["cashed"], out["totals"]["amount"]) == (1, 200.0)
        assert out["bad_checks"]["returned"] == 0
        assert out["bad_checks"]["open_count"] == 1  # right now
        # Backwards range is swapped; bad dates fall back.
        swapped = client.get(f"{REPORT}?from={TODAY.isoformat()}&to={y}",
                             headers=admin).json()
        assert (swapped["from_day"], swapped["to_day"]) == (y, TODAY.isoformat())
        assert client.get(f"{REPORT}?from=bad", headers=admin).status_code == 200

    def test_empty_period(self, client, admin):
        out = client.get(REPORT, headers=admin).json()
        assert out["totals"]["cashed"] == 0 and out["totals"]["average"] == 0.0
        assert (out["stores"], out["days"], out["companies"]) == ([], [], [])

    def test_opens_on_any_device(self, client, admin, on, activity):
        from tests.conftest import _starlette_client
        _starlette_client.cookies.clear()
        h = _h(login_admin(client, on))
        assert client.get(CHECKS, headers=h).status_code == 403  # the desk is locked
        assert client.get(REPORT, headers=h).status_code == 200

    def test_cashier_reads_it(self, client, cashier, activity):
        assert client.get(REPORT, headers=cashier).status_code == 200

    def test_sibling_stores_and_one_store(self, client, admin, on, party):
        cust, comp = party
        _cash(client, admin, cust, comp, amount=100)
        sibling = _new_store("cc-rep-sib")
        _flag(sibling, True)
        _link_owner(on, sibling)
        from tests.conftest import _starlette_client
        _starlette_client.cookies.clear()
        h = _h(login_admin(client, sibling))
        _activate(client, h)
        _cash(client, h, cust, comp, amount=40, check_number="9", ack=["cashed_today"])
        both = client.get(REPORT, headers=h).json()
        assert both["totals"]["amount"] == 140.0
        assert len(both["stores"]) == 2 and len(both["store_options"]) == 2
        mine = client.get(f"{REPORT}?store_id={sibling}", headers=h).json()
        assert mine["totals"]["amount"] == 40.0
        other = _new_store("cc-rep-other")
        assert client.get(f"{REPORT}?store_id={other}", headers=h).status_code == 403

    def test_owner_without_a_store(self, client, admin, on, party):
        cust, comp = party
        _cash(client, admin, cust, comp, amount=100)
        off = _new_store("cc-rep-off")  # check cashing off there
        _link_owner(on, off)
        h = _h(login_owner(client, "cc-owner@x.com"))
        out = client.get(REPORT, headers=h)
        assert out.status_code == 200, out.text
        assert out.json()["totals"]["amount"] == 100.0
        assert [s["id"] for s in out.json()["store_options"]] == [on]
        assert client.get(f"{REPORT}?store_id={off}", headers=h).status_code == 403
        _flag(on, False)
        assert client.get(REPORT, headers=h).status_code == 403

    def test_unrelated_store_sees_nothing(self, client, admin, activity):
        other = _new_store("cc-rep-unrel")
        _flag(other, True)
        h = _h(login_admin(client, other))
        out = client.get(REPORT, headers=h).json()
        assert out["totals"]["cashed"] == 0
        assert out["bad_checks"]["open_count"] == 0


class TestGates:
    def test_refused_while_off(self, client, test_store_id):
        h = _h(login_admin(client, test_store_id))
        resp = client.get(REPORT, headers=h)
        assert resp.status_code == 403
        assert "not turned on" in resp.json()["detail"]

    def test_refused_without_rights(self, client, on):
        nobody, _ = _employee(client, on, "cc_rep_gate", {"time_clock": {"read": True}})
        assert client.get(REPORT, headers=nobody).status_code == 403

    def test_accountant_refused(self, client, on):
        from api.Modules.Tenancy.Models import User
        with db_session():
            u = User(store_id=on, username="cc-rep-acct@x.com",
                     full_name="Acct", role="accountant")
            u.set_password("acctpass1234")
            db.session.add(u)
            db.session.commit()
        h = _h(login_employee(client, on, "cc-rep-acct@x.com", "acctpass1234"))
        assert client.get(REPORT, headers=h).status_code == 403

    def test_signed_out(self, client, on):
        assert client.get(REPORT).status_code == 401


def test_owner_session_gets_the_report_flag_only_when_a_store_has_it(client, test_store_id):
    """An owner without a store sees the report link (``check_desk_report``)
    once one of their stores has check cashing on; never the desk flag."""
    _link_owner(test_store_id)
    h = _h(login_owner(client, "cc-owner@x.com"))
    url = "/api/v2/auth/session-status"
    features = client.get(url, headers=h).json()["features"]
    assert "check_desk_report" not in features
    _flag(test_store_id, True)
    features = client.get(url, headers=h).json()["features"]
    assert "check_desk_report" in features
    assert "check_desk" not in features  # no store: no desk
    admin_h = _h(login_admin(client, test_store_id))
    assert "check_desk_report" not in client.get(url, headers=admin_h).json()["features"]
