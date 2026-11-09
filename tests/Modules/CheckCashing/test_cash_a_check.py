"""Check cashing module, PR 2: Cash a check —
api/Modules/CheckCashing/INVARIANTS.md ("Cash a check").

The rules under test:
  * the fee: the customer's own, else the company's, else the store's;
    the base charge lifts a small check's fee; never above the check;
  * the review and its levels (info / warn / approve / block), each
    code raised by its cause;
  * cashing needs ``check_cashing.create``, every warning ticked, no
    block, and a manager (``check_cashing_manage.update``) for an
    approval; "not accepted" is always saved with its reason;
  * a void: manager only, at the cashing store, on that store day;
  * activity totals per store and across the owner's stores, isolated
    from unrelated stores;
  * every outcome writes an operator-audit row; purge keeps a sibling
    store's records.
"""
from datetime import date, timedelta

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin
from tests.Modules.CheckCashing.test_check_cashing import (  # noqa: F401
    BASE, _audit_actions, _employee, _flag, _h, _link_owner, _mk_company,
    _mk_customer, _new_store, admin, cashier, on,
)

CHECKS = f"{BASE}/checks"
CASHIER_RIGHTS = {"check_cashing": {"create": True, "read": True, "update": True}}


def _settings(client, h, **over):
    body = {"default_fee_kind": "percent", "default_fee_value": 2,
            "expired_id_mode": "warn", **over}
    resp = client.put(f"{BASE}/settings", headers=h, json=body)
    assert resp.status_code == 200, resp.text


def _review(client, h, **body):
    resp = client.post(f"{CHECKS}/review", headers=h, json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _levels(review):
    return {i["code"]: i["level"] for i in review["items"]}


def _cash(client, h, cust, comp, amount=500, fee=None, ack=(), **over):
    body = {"customer_id": cust["id"], "company_id": comp["id"],
            "check_number": "1001", "amount": amount,
            "fee": amount * 0.02 if fee is None else fee,
            "acknowledged": list(ack), **over}
    return client.post(CHECKS, headers=h, json=body)


@pytest.fixture
def party(client, admin):
    _settings(client, admin)
    return _mk_customer(client, admin), _mk_company(client, admin)


# ── The fee ─────────────────────────────────────────────────


class TestFee:
    def test_store_default_percent(self, client, admin, party):
        cust, comp = party
        fee = _review(client, admin, customer_id=cust["id"],
                      company_id=comp["id"], amount=500)["fee"]
        assert fee == {"kind": "percent", "value": 2.0, "fee": 10.0,
                       "source": "store", "base_applied": False}

    def test_company_then_customer_override(self, client, admin):
        _settings(client, admin)
        comp = _mk_company(client, admin, fee_kind="flat", fee_value=4)
        cust = _mk_customer(client, admin)
        fee = _review(client, admin, customer_id=cust["id"],
                      company_id=comp["id"], amount=500)["fee"]
        assert (fee["source"], fee["fee"]) == ("company", 4.0)
        own = _mk_customer(client, admin, "Own Fee", fee_kind="percent",
                           fee_value=1)
        fee = _review(client, admin, customer_id=own["id"],
                      company_id=comp["id"], amount=500)["fee"]
        assert (fee["source"], fee["fee"]) == ("customer", 5.0)

    def test_base_charge_and_cap(self, client, admin, party):
        cust, comp = party
        _settings(client, admin, base_charge=3, base_charge_under=100)
        small = _review(client, admin, customer_id=cust["id"],
                        company_id=comp["id"], amount=50)["fee"]
        assert (small["fee"], small["base_applied"]) == (3.0, True)
        big = _review(client, admin, customer_id=cust["id"],
                      company_id=comp["id"], amount=500)["fee"]
        assert (big["fee"], big["base_applied"]) == (10.0, False)
        tiny = _review(client, admin, customer_id=cust["id"],
                       company_id=comp["id"], amount=2)["fee"]
        assert tiny["fee"] == 2.0  # never more than the check

    def test_percent_rounds_half_up(self):
        from api.Modules.CheckCashing.Services.cashing import percent_of
        assert percent_of(12_345, 150) == 185   # 185.175 → 185
        assert percent_of(10_050, 150) == 151   # 150.75 → 151
        assert percent_of(1_000, 5) == 1        # 0.5 → 1

    def test_no_amount_no_fee(self, client, admin, party):
        cust, comp = party
        assert _review(client, admin, customer_id=cust["id"],
                       company_id=comp["id"])["fee"] is None


# ── The review ─────────────────────────────────────────────


class TestReview:
    def test_clean_first_check(self, client, admin, party):
        cust, comp = party
        r = _review(client, admin, customer_id=cust["id"],
                    company_id=comp["id"], amount=500,
                    check_date=date.today().isoformat())
        assert _levels(r) == {"first_check": "info"}

    def test_blocked_parties_block(self, client, admin):
        _settings(client, admin)
        cust = _mk_customer(client, admin, status="blocked",
                            status_reason="Fraud")
        comp = _mk_company(client, admin, status="blocked",
                           status_reason="Closed")
        levels = _levels(_review(client, admin, customer_id=cust["id"],
                                 company_id=comp["id"], amount=10))
        assert levels["customer_blocked"] == "block"
        assert levels["company_blocked"] == "block"

    def test_trusted_is_info(self, client, admin):
        cust = _mk_customer(client, admin, status="trusted")
        comp = _mk_company(client, admin, status="trusted")
        levels = _levels(_review(client, admin, customer_id=cust["id"],
                                 company_id=comp["id"], amount=10))
        assert levels["customer_trusted"] == "info"
        assert levels["company_trusted"] == "info"

    def test_expired_id_follows_the_setting(self, client, admin):
        old = {"id_type": "state_id", "id_number": "S1", "expires_on": "2020-01-01"}
        cust = _mk_customer(client, admin, ids=[old])
        _settings(client, admin)
        assert _levels(_review(client, admin, customer_id=cust["id"],
                               amount=10))["id_expired"] == "warn"
        _settings(client, admin, expired_id_mode="block")
        assert _levels(_review(client, admin, customer_id=cust["id"],
                               amount=10))["id_expired"] == "block"
        # One valid ID is enough.
        client.post(f"{BASE}/customers/{cust['id']}/ids", headers=admin,
                    json={"id_type": "passport", "id_number": "P1"})
        assert "id_expired" not in _levels(
            _review(client, admin, customer_id=cust["id"], amount=10))

    def test_no_id_blocks(self, client, admin, party):
        from api.Modules.CheckCashing.Models import CheckCustomerId
        cust, comp = party
        with db_session():
            db.session.query(CheckCustomerId).filter_by(
                customer_id=cust["id"]).delete()
            db.session.commit()
        assert _levels(_review(client, admin, customer_id=cust["id"],
                               amount=10))["no_id"] == "block"

    def test_dates(self, client, admin, party):
        cust, comp = party
        future = (date.today() + timedelta(days=3)).isoformat()
        stale = (date.today() - timedelta(days=200)).isoformat()
        assert _levels(_review(client, admin, company_id=comp["id"],
                               check_date=future))["future_dated"] == "warn"
        assert _levels(_review(client, admin, company_id=comp["id"],
                               check_date=stale))["stale_dated"] == "warn"

    def test_after_cashing_today_duplicate_and_limit(self, client, admin, party):
        cust, comp = party
        _settings(client, admin, daily_limit=800)
        assert _cash(client, admin, cust, comp, ack=()).status_code == 201
        r = _review(client, admin, customer_id=cust["id"],
                    company_id=comp["id"], check_number="1001", amount=400)
        items = {i["code"]: i for i in r["items"]}
        assert "first_check" not in items
        assert items["cashed_today"]["level"] == "warn"
        assert (items["cashed_today"]["count"], items["cashed_today"]["amount"]) == (1, 500.0)
        assert items["duplicate"]["level"] == "approve"
        assert items["duplicate"]["day"] == date.today().isoformat()
        assert items["daily_limit"] == {"code": "daily_limit", "level": "approve",
                                        "count": None, "amount": 800.0, "day": None}
        assert (r["today_count"], r["today_total"]) == (1, 500.0)
        # A different check number is no duplicate.
        other = _review(client, admin, customer_id=cust["id"],
                        company_id=comp["id"], check_number="1002", amount=10)
        assert "duplicate" not in _levels(other)

    def test_ctr_alert_over_ten_thousand(self, client, admin, party):
        cust, comp = party
        r = _review(client, admin, customer_id=cust["id"],
                    company_id=comp["id"], amount=10_000.01)
        assert _levels(r)["ctr_due"] == "info"
        assert "ctr_due" not in _levels(_review(
            client, admin, customer_id=cust["id"], company_id=comp["id"],
            amount=10_000))

    def test_review_changes_nothing(self, client, admin, party):
        from api.Modules.CheckCashing.Models import CashedCheck
        cust, comp = party
        _review(client, admin, customer_id=cust["id"], company_id=comp["id"],
                amount=50)
        with db_session():
            assert db.session.query(CashedCheck).count() == 0

    def test_rejects_bad_numbers(self, client, admin, party):
        cust, comp = party
        for body in ({"amount": -1}, {"amount": 2_000_000},
                     {"check_number": "x" * 21}, {"customer_id": 0}):
            resp = client.post(f"{CHECKS}/review", headers=admin, json=body)
            assert resp.status_code == 422, body
        resp = client.post(f"{CHECKS}/review", headers=admin,
                           content=b'{"amount": NaN}',
                           )
        assert resp.status_code == 422


# ── Cash, decline, void ────────────────────────────────────


class TestCash:
    def test_cash_saves_fee_cash_and_audit(self, client, admin, on, party):
        cust, comp = party
        resp = _cash(client, admin, cust, comp, amount=500, fee=8,
                     check_date=date.today().isoformat(), micr="⑆111000025⑆")
        assert resp.status_code == 201, resp.text
        row = resp.json()["check"]
        assert (row["amount"], row["fee"], row["cash"]) == (500.0, 8.0, 492.0)
        assert row["status"] == "cashed"
        assert row["customer_name"] == "Ana Lopez"
        assert row["company_name"] == "PD Electric LLC"
        assert row["can_void"] is True
        from api.Modules.CheckCashing.Models import CashedCheck
        with db_session():
            saved = db.session.get(CashedCheck, row["id"])
            assert saved.fee_suggested_cents == 1000
            assert saved.fee_cents == 800
            assert saved.store_day == date.today()
        assert _audit_actions(on)[-1] == "cash_check"

    def test_blocks_refuse_cashing(self, client, admin):
        _settings(client, admin)
        cust = _mk_customer(client, admin, status="blocked",
                            status_reason="Fraud")
        comp = _mk_company(client, admin)
        resp = _cash(client, admin, cust, comp, ack=["customer_blocked"])
        assert resp.status_code == 409
        assert "customer_blocked" in resp.json()["detail"]

    def test_warnings_must_be_ticked(self, client, admin, party):
        cust, comp = party
        future = (date.today() + timedelta(days=3)).isoformat()
        resp = _cash(client, admin, cust, comp, check_date=future)
        assert resp.status_code == 409
        assert "future_dated" in resp.json()["detail"]
        resp = _cash(client, admin, cust, comp, check_date=future,
                     ack=["future_dated"])
        assert resp.status_code == 201
        assert resp.json()["check"]["warnings"] == ["future_dated"]

    def test_fee_above_check_refused(self, client, admin, party):
        cust, comp = party
        resp = _cash(client, admin, cust, comp, amount=5, fee=6)
        assert resp.status_code == 409

    def test_approval_needs_a_manager(self, client, admin, on, party):
        cust, comp = party
        assert _cash(client, admin, cust, comp).status_code == 201
        emp, uid = _employee(client, on, "cc_cash", CASHIER_RIGHTS)
        ack = ["cashed_today", "duplicate"]
        resp = _cash(client, emp, cust, comp, ack=ack)
        assert resp.status_code == 403
        assert "duplicate" in resp.json()["detail"]
        from api.Core.Permissions import set_user_permissions
        set_user_permissions(on, uid, {**CASHIER_RIGHTS,
                                       "check_cashing_manage": {"update": True}})
        resp = _cash(client, emp, cust, comp, ack=ack)
        assert resp.status_code == 201, resp.text
        assert resp.json()["check"]["approved"] is True
        # An approval still has to be ticked.
        assert _cash(client, admin, cust, comp,
                     ack=["cashed_today"]).status_code == 409

    def test_cashier_cashes_a_clean_check(self, client, cashier, admin, party):
        cust, comp = party
        resp = _cash(client, cashier, cust, comp)
        assert resp.status_code == 201
        assert resp.json()["check"]["can_void"] is False

    def test_read_only_cannot_cash(self, client, on, party):
        cust, comp = party
        reader, _ = _employee(client, on, "cc_reader",
                              {"check_cashing": {"read": True}})
        assert client.post(f"{CHECKS}/review", headers=reader, json={
            "customer_id": cust["id"], "amount": 10,
        }).status_code == 200
        assert _cash(client, reader, cust, comp).status_code == 403
        assert _cash(client, reader, cust, comp, decision="decline",
                     reason="No").status_code == 403

    def test_decline_is_saved_even_when_blocked(self, client, admin, on):
        cust = _mk_customer(client, admin, status="blocked",
                            status_reason="Fraud")
        comp = _mk_company(client, admin)
        resp = _cash(client, admin, cust, comp, decision="decline",
                     reason="Altered amount")
        assert resp.status_code == 201, resp.text
        row = resp.json()["check"]
        assert (row["status"], row["reason"]) == ("declined", "Altered amount")
        assert (row["fee"], row["cash"]) == (0.0, 0.0)
        assert _audit_actions(on)[-1] == "decline_check"
        # A refusal does not count towards today's total.
        r = _review(client, admin, customer_id=cust["id"], amount=10)
        assert r["today_count"] == 0

    def test_decline_needs_a_reason(self, client, admin, party):
        cust, comp = party
        resp = _cash(client, admin, cust, comp, decision="decline", reason=" ")
        assert resp.status_code == 422

    def test_unknown_party_404(self, client, admin, party):
        cust, comp = party
        resp = _cash(client, admin, cust, {"id": 99999})
        assert resp.status_code == 404


class TestVoid:
    def _cashed(self, client, admin, party):
        cust, comp = party
        return _cash(client, admin, cust, comp).json()["check"]

    def test_manager_voids_same_day(self, client, admin, on, party):
        row = self._cashed(client, admin, party)
        resp = client.post(f"{CHECKS}/{row['id']}/void", headers=admin,
                           json={"reason": "Wrong amount"})
        assert resp.status_code == 200, resp.text
        out = resp.json()["check"]
        assert (out["status"], out["void_reason"], out["can_void"]) == (
            "voided", "Wrong amount", False)
        assert _audit_actions(on)[-1] == "void_check"
        # Voided checks leave today's total.
        r = _review(client, admin, customer_id=party[0]["id"], amount=10)
        assert r["today_count"] == 0
        again = client.post(f"{CHECKS}/{row['id']}/void", headers=admin,
                            json={"reason": "x"})
        assert again.status_code == 409

    def test_cashier_cannot_void(self, client, admin, cashier, party):
        row = self._cashed(client, admin, party)
        resp = client.post(f"{CHECKS}/{row['id']}/void", headers=cashier,
                           json={"reason": "x"})
        assert resp.status_code == 403

    def test_not_on_a_later_day(self, client, admin, party):
        from api.Modules.CheckCashing.Models import CashedCheck
        row = self._cashed(client, admin, party)
        with db_session():
            db.session.get(CashedCheck, row["id"]).store_day = (
                date.today() - timedelta(days=1))
            db.session.commit()
        resp = client.post(f"{CHECKS}/{row['id']}/void", headers=admin,
                           json={"reason": "x"})
        assert resp.status_code == 409

    def test_needs_a_reason(self, client, admin, party):
        row = self._cashed(client, admin, party)
        resp = client.post(f"{CHECKS}/{row['id']}/void", headers=admin,
                           json={"reason": ""})
        assert resp.status_code == 422

    def test_only_at_the_cashing_store(self, client, admin, on, party):
        row = self._cashed(client, admin, party)
        sibling = _new_store("cc-void-sib")
        _flag(sibling, True)
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        listed = client.get(CHECKS, headers=h).json()["rows"]
        assert [r["can_void"] for r in listed] == [False]
        resp = client.post(f"{CHECKS}/{row['id']}/void", headers=h,
                           json={"reason": "x"})
        assert resp.status_code == 404


# ── Lists, activity, lookups ───────────────────────────────


class TestActivity:
    def test_list_filters(self, client, admin, party):
        cust, comp = party
        other = _mk_customer(client, admin, "Bea Diaz")
        _cash(client, admin, cust, comp)
        _cash(client, admin, other, comp, check_number="2001")
        _cash(client, admin, other, comp, decision="decline", reason="No")
        assert client.get(CHECKS, headers=admin).json()["total"] == 3
        by = client.get(f"{CHECKS}?customer_id={other['id']}",
                        headers=admin).json()
        assert by["total"] == 2
        declined = client.get(f"{CHECKS}?status=declined", headers=admin).json()
        assert [r["reason"] for r in declined["rows"]] == ["No"]
        today = client.get(f"{CHECKS}?day={date.today().isoformat()}",
                           headers=admin).json()
        assert today["total"] == 3
        assert client.get(f"{CHECKS}?status=bad", headers=admin).status_code == 422

    def test_customer_and_company_stats(self, client, admin, party):
        cust, comp = party
        _cash(client, admin, cust, comp, amount=300, check_number="1")
        _cash(client, admin, cust, comp, amount=100, check_number="2",
              ack=["cashed_today"])
        _cash(client, admin, cust, comp, decision="decline", reason="No")
        act = client.get(f"{BASE}/customers/{cust['id']}/activity",
                         headers=admin).json()
        assert [s["scope"] for s in act["stats"]] == ["store"]
        s = act["stats"][0]
        assert (s["count"], s["total"], s["biggest"], s["average"]) == (
            2, 400.0, 300.0, 200.0)
        assert (s["last_amount"], s["declined"], s["voided"]) == (100.0, 1, 0)
        assert len(act["recent"]) == 3
        comp_act = client.get(f"{BASE}/companies/{comp['id']}/activity",
                              headers=admin).json()
        assert comp_act["stats"][0]["count"] == 2
        people = client.get(f"{BASE}/companies/{comp['id']}/customers",
                            headers=admin).json()["rows"]
        assert [(p["full_name"], p["checks"]) for p in people] == [("Ana Lopez", 2)]

    def test_owner_stores_add_an_all_stores_line(self, client, admin, on, party):
        cust, comp = party
        _cash(client, admin, cust, comp, amount=300)
        sibling = _new_store("cc-act-sib")
        _flag(sibling, True)
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        resp = _cash(client, h, cust, comp, amount=200, check_number="77",
                     ack=["cashed_today"])
        assert resp.status_code == 201, resp.text
        act = client.get(f"{BASE}/customers/{cust['id']}/activity",
                         headers=h).json()
        by_scope = {s["scope"]: s for s in act["stats"]}
        assert by_scope["store"]["total"] == 200.0
        assert by_scope["all"]["total"] == 500.0
        # The daily limit and same-day count read every owner store.
        r = _review(client, h, customer_id=cust["id"], amount=1)
        assert r["today_total"] == 500.0

    def test_unrelated_store_sees_nothing(self, client, admin, party):
        cust, comp = party
        row = _cash(client, admin, cust, comp).json()["check"]
        other = _new_store("cc-act-other")
        _flag(other, True)
        h = _h(login_admin(client, other))
        assert client.get(CHECKS, headers=h).json()["total"] == 0
        for path in (f"/customers/{cust['id']}/activity",
                     f"/companies/{comp['id']}/activity",
                     f"/companies/{comp['id']}/customers"):
            assert client.get(BASE + path, headers=h).status_code == 404, path
        assert client.post(f"{CHECKS}/review", headers=h, json={
            "customer_id": cust["id"]}).status_code == 404
        assert _cash(client, h, cust, comp).status_code == 404
        assert client.post(f"{CHECKS}/{row['id']}/void", headers=h,
                           json={"reason": "x"}).status_code == 404

    def test_company_lookup(self, client, admin, party):
        cust, comp = party
        found = client.get(
            f"{BASE}/company-lookup?routing={comp['routing_number']}"
            f"&account={comp['account_number']}", headers=admin,
        ).json()
        assert found["company"]["id"] == comp["id"]
        missing = client.get(
            f"{BASE}/company-lookup?routing=021000021&account=1", headers=admin,
        ).json()
        assert missing["company"] is None
        assert client.get(f"{BASE}/company-lookup?routing=12",
                          headers=admin).status_code == 422


# ── Gates ───────────────────────────────────────────────────


class TestGates:
    ROUTES = (
        ("post", "/checks/review", {"amount": 1}),
        ("post", "/checks", {"customer_id": 1, "company_id": 1, "amount": 1}),
        ("get", "/checks", None),
        ("post", "/checks/1/void", {"reason": "x"}),
        ("get", "/customers/1/activity", None),
        ("get", "/companies/1/activity", None),
        ("get", "/companies/1/customers", None),
        ("get", "/company-lookup", None),
    )

    def _call(self, client, method, path, body, h):
        if body is None:
            return getattr(client, method)(BASE + path, headers=h)
        return getattr(client, method)(BASE + path, headers=h, json=body)

    def test_refused_while_off(self, client, test_store_id):
        h = _h(login_admin(client, test_store_id))
        for method, path, body in self.ROUTES:
            resp = self._call(client, method, path, body, h)
            assert resp.status_code == 403, (path, resp.text)

    def test_refused_without_rights(self, client, on):
        nobody, _ = _employee(client, on, "cc_gate",
                              {"time_clock": {"read": True}})
        for method, path, body in self.ROUTES:
            assert self._call(client, method, path, body, nobody).status_code == 403

    def test_accountant_refused(self, client, on):
        from api.Modules.Tenancy.Models import User
        from tests.conftest import login_employee
        with db_session():
            u = User(store_id=on, username="cc-acct2@x.com",
                     full_name="Acct", role="accountant")
            u.set_password("acctpass1234")
            db.session.add(u)
            db.session.commit()
        h = _h(login_employee(client, on, "cc-acct2@x.com", "acctpass1234"))
        for method, path, body in self.ROUTES:
            assert self._call(client, method, path, body, h).status_code == 403

    def test_signed_out(self, client, on):
        for method, path, body in self.ROUTES:
            assert self._call(client, method, path, body, None).status_code == 401


# ── Settings, purge ─────────────────────────────────────────


def test_daily_limit_setting_roundtrip(client, admin, cashier):
    _settings(client, admin, daily_limit=2500)
    assert client.get(f"{BASE}/settings", headers=cashier).json()[
        "daily_limit"] == 2500.0
    _settings(client, admin)
    assert client.get(f"{BASE}/settings", headers=admin).json()[
        "daily_limit"] is None
    resp = client.put(f"{BASE}/settings", headers=admin, json={
        "default_fee_kind": "percent", "default_fee_value": 1,
        "daily_limit": 0})
    assert resp.status_code == 422


def test_cashed_checks_purge_first():
    from api.Modules.Billing.Services.retention import _store_owned_models
    from api.Modules.CheckCashing.Models import (
        CashedCheck, CheckCompany, CheckCustomer,
    )
    pairs = _store_owned_models()
    i = pairs.index((CashedCheck, "store_id"))
    assert i < pairs.index((CheckCustomer, "store_id"))
    assert i < pairs.index((CheckCompany, "store_id"))


def test_purge_keeps_a_sibling_stores_records(client, admin, on, party):
    """Store A added the customer and company; sibling B cashed a
    check for them. Purging A deletes A's checks but moves the shared
    customer (with IDs) and company to B, so B's record stands."""
    from datetime import timedelta as td

    from api.Core.Clock import utc_now
    from api.Modules.Billing.Services.retention import purge_expired_stores
    from api.Modules.CheckCashing.Models import (
        CashedCheck, CheckCompany, CheckCustomer, CheckCustomerId,
    )
    from api.Modules.Tenancy.Models import Store
    cust, comp = party
    alone = _mk_customer(client, admin, "Only Here")
    _cash(client, admin, alone, comp, check_number="5")
    sibling = _new_store("cc-purge-sib")
    _flag(sibling, True)
    _link_owner(on, sibling)
    h = _h(login_admin(client, sibling))
    kept = _cash(client, h, cust, comp, check_number="9").json()["check"]
    with db_session():
        store = db.session.get(Store, on)
        store.plan = "inactive"
        store.data_retention_until = utc_now() - td(days=1)
        db.session.commit()
        assert purge_expired_stores(db.session) == 1
        assert [c.id for c in db.session.query(CashedCheck)] == [kept["id"]]
        moved = db.session.get(CheckCustomer, cust["id"])
        assert moved is not None and moved.store_id == sibling
        assert {i.store_id for i in db.session.query(CheckCustomerId)
                .filter_by(customer_id=cust["id"])} == {sibling}
        assert db.session.get(CheckCompany, comp["id"]).store_id == sibling
        assert db.session.get(CheckCustomer, alone["id"]) is None
