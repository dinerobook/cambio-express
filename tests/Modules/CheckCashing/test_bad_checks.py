"""Check cashing module, PR 5: bad checks —
api/Modules/CheckCashing/INVARIANTS.md ("Bad checks").

The rules under test:
  * a manager (``check_cashing_manage.update``) marks a cashed check
    as sent back, at the store that cashed it, once; the customer owes
    the check plus the returned-check fee;
  * a payback (``check_cashing.create``) at any store of the owner,
    never more than what is left; the bad check is paid at zero;
  * a manager writes off what is left, with a reason; a closed bad
    check takes nothing more;
  * while one is open, Cash a check asks a manager to approve the next
    check of that customer or company; a bad check cannot be voided;
  * the list (status, live search, open total) and the detail, owner
    umbrella only;
  * every change is audited; the purge keeps a sibling store's records.
"""
from datetime import date, timedelta

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee
from tests.Modules.CheckCashing.test_cash_a_check import (  # noqa: F401
    CHECKS, _cash, _levels, _review, _settings, party,
)
from tests.Modules.CheckCashing.test_check_cashing import (  # noqa: F401
    BASE, _activate, _audit_actions, _employee, _flag, _h, _link_owner,
    _mk_company, _mk_customer, _new_store, admin, cashier, on,
)

BAD = f"{BASE}/bad-checks"
TODAY = date.today().isoformat()


def _report(client, h, check_id, **over):
    body = {"reason": "nsf", "returned_on": TODAY, "fee": 25, **over}
    return client.post(f"{CHECKS}/{check_id}/bad-check", headers=h, json=body)


def _pay(client, h, bad_id, amount, **over):
    return client.post(f"{BAD}/{bad_id}/payments", headers=h,
                       json={"amount": amount, **over})


@pytest.fixture
def cashed(client, admin, party):
    cust, comp = party
    resp = _cash(client, admin, cust, comp, amount=500)
    assert resp.status_code == 201, resp.text
    return resp.json()["check"]


@pytest.fixture
def bad(client, admin, cashed):
    resp = _report(client, admin, cashed["id"])
    assert resp.status_code == 201, resp.text
    return resp.json()


# ── Reporting ──────────────────────────────────────────────


class TestReport:
    def test_manager_reports(self, client, admin, on, cashed):
        assert cashed["can_report_bad"] is True
        resp = _report(client, admin, cashed["id"], note="Bank notice 11/11")
        assert resp.status_code == 201, resp.text
        out = resp.json()
        b = out["bad_check"]
        assert (b["status"], b["reason"], b["amount"], b["fee"], b["owed"],
                b["paid"], b["balance"]) == (
            "open", "nsf", 500.0, 25.0, 525.0, 0.0, 525.0)
        assert b["note"] == "Bank notice 11/11"
        assert (out["can_pay"], out["can_write_off"]) == (True, True)
        row = out["check"]
        assert row["bad_check"] == {"id": b["id"], "status": "open",
                                    "reason": "nsf", "balance": 525.0}
        assert (row["can_report_bad"], row["can_void"]) == (False, False)
        assert _audit_actions(on)[-1] == "report_bad_check"

    def test_only_once(self, client, admin, cashed, bad):
        assert _report(client, admin, cashed["id"]).status_code == 409

    def test_cashier_cannot_report(self, client, cashier, cashed):
        listed = client.get(CHECKS, headers=cashier).json()["rows"]
        assert [r["can_report_bad"] for r in listed] == [False]
        assert _report(client, cashier, cashed["id"]).status_code == 403

    def test_only_a_cashed_check(self, client, admin, party):
        cust, comp = party
        declined = _cash(client, admin, cust, comp, decision="decline",
                         reason="No").json()["check"]
        assert _report(client, admin, declined["id"]).status_code == 409

    def test_return_date_window(self, client, admin, cashed):
        future = (date.today() + timedelta(days=1)).isoformat()
        before = (date.today() - timedelta(days=1)).isoformat()
        assert _report(client, admin, cashed["id"],
                       returned_on=future).status_code == 409
        assert _report(client, admin, cashed["id"],
                       returned_on=before).status_code == 409

    @pytest.mark.parametrize("over", [
        {"reason": "bounced"}, {"fee": -1}, {"fee": 20_000},
        {"note": "x" * 256}, {"returned_on": "soon"},
    ])
    def test_bad_bodies(self, client, admin, cashed, over):
        assert _report(client, admin, cashed["id"], **over).status_code == 422

    def test_only_at_the_cashing_store(self, client, admin, on, cashed):
        sibling = _new_store("cc-bad-sib")
        _flag(sibling, True)
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        _activate(client, h)
        listed = client.get(CHECKS, headers=h).json()["rows"]
        assert [r["can_report_bad"] for r in listed] == [False]
        assert _report(client, h, cashed["id"]).status_code == 404

    def test_unknown_check_404(self, client, admin, on):
        assert _report(client, admin, 99999).status_code == 404

    def test_a_bad_check_cannot_be_voided(self, client, admin, cashed, bad):
        resp = client.post(f"{CHECKS}/{cashed['id']}/void", headers=admin,
                           json={"reason": "x"})
        assert resp.status_code == 409


# ── Paybacks and write-off ─────────────────────────────────


class TestPayback:
    def test_paid_in_parts_then_closed(self, client, admin, cashier, on, bad):
        bid = bad["bad_check"]["id"]
        resp = _pay(client, cashier, bid, 200, note="Cash")
        assert resp.status_code == 201, resp.text
        out = resp.json()
        assert (out["bad_check"]["paid"], out["bad_check"]["balance"],
                out["bad_check"]["status"]) == (200.0, 325.0, "open")
        assert [(p["amount"], p["note"], p["paid_on"]) for p in out["payments"]] == [
            (200.0, "Cash", TODAY)]
        assert out["payments"][0]["store_name"]
        assert _audit_actions(on)[-1] == "add_bad_check_payment"
        assert (out["can_pay"], out["can_write_off"]) == (True, False)
        done = _pay(client, cashier, bid, 325).json()
        assert (done["bad_check"]["status"], done["bad_check"]["balance"]) == (
            "paid", 0.0)
        assert (done["can_pay"], done["can_write_off"]) == (False, False)
        assert _pay(client, cashier, bid, 1).status_code == 409

    def test_never_more_than_owed(self, client, admin, bad):
        resp = _pay(client, admin, bad["bad_check"]["id"], 525.01)
        assert resp.status_code == 409
        assert "525.00" in resp.json()["detail"]

    @pytest.mark.parametrize("amount", [0, -5, 2_000_000])
    def test_bad_amounts(self, client, admin, bad, amount):
        assert _pay(client, admin, bad["bad_check"]["id"], amount).status_code == 422

    def test_read_only_cannot_pay(self, client, admin, on, bad):
        reader, _ = _employee(client, on, "cc_bad_reader",
                              {"check_cashing": {"read": True}})
        assert _pay(client, reader, bad["bad_check"]["id"], 5).status_code == 403
        out = client.get(f"{BAD}/{bad['bad_check']['id']}", headers=reader).json()
        assert (out["can_pay"], out["can_write_off"]) == (False, False)

    def test_paid_back_at_a_sibling_store(self, client, admin, on, bad):
        sibling = _new_store("cc-bad-pay-sib")
        _flag(sibling, True)
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        _activate(client, h)
        out = _pay(client, h, bad["bad_check"]["id"], 25).json()
        assert out["payments"][0]["store_name"] != out["bad_check"]["store_name"]

    def test_unrelated_store_cannot_see_or_pay(self, client, admin, bad):
        other = _new_store("cc-bad-other")
        _flag(other, True)
        h = _h(login_admin(client, other))
        _activate(client, h)
        bid = bad["bad_check"]["id"]
        assert client.get(f"{BAD}/{bid}", headers=h).status_code == 404
        assert _pay(client, h, bid, 5).status_code == 404
        assert client.get(BAD, headers=h).json()["total"] == 0


class TestWriteOff:
    def test_manager_writes_off_the_rest(self, client, admin, on, bad):
        bid = bad["bad_check"]["id"]
        _pay(client, admin, bid, 100)
        resp = client.post(f"{BAD}/{bid}/write-off", headers=admin,
                           json={"note": "Customer moved away"})
        assert resp.status_code == 200, resp.text
        b = resp.json()["bad_check"]
        assert (b["status"], b["write_off_note"], b["balance"]) == (
            "written_off", "Customer moved away", 425.0)
        assert _audit_actions(on)[-1] == "write_off_bad_check"
        again = client.post(f"{BAD}/{bid}/write-off", headers=admin,
                            json={"note": "x"})
        assert again.status_code == 409
        assert _pay(client, admin, bid, 5).status_code == 409

    def test_needs_a_reason(self, client, admin, bad):
        resp = client.post(f"{BAD}/{bad['bad_check']['id']}/write-off",
                           headers=admin, json={"note": "  "})
        assert resp.status_code == 422

    def test_cashier_cannot_write_off(self, client, cashier, bad):
        resp = client.post(f"{BAD}/{bad['bad_check']['id']}/write-off",
                           headers=cashier, json={"note": "x"})
        assert resp.status_code == 403


# ── The review at the counter ──────────────────────────────


class TestReview:
    def test_open_bad_check_needs_a_manager(self, client, admin, cashier, party, bad):
        cust, comp = party
        r = _review(client, cashier, customer_id=cust["id"],
                    company_id=comp["id"], amount=100)
        levels = _levels(r)
        assert levels["customer_bad_check"] == "approve"
        assert levels["company_bad_check"] == "approve"
        item = next(i for i in r["items"] if i["code"] == "customer_bad_check")
        assert (item["count"], item["amount"]) == (1, 525.0)
        ack = ["customer_bad_check", "company_bad_check", "cashed_today"]
        assert _cash(client, cashier, cust, comp, amount=100,
                     check_number="2", ack=ack).status_code == 403
        assert _cash(client, admin, cust, comp, amount=100,
                     check_number="2", ack=["cashed_today"]).status_code == 409
        resp = _cash(client, admin, cust, comp, amount=100, check_number="2",
                     ack=ack)
        assert resp.status_code == 201, resp.text
        assert resp.json()["check"]["approved"] is True

    def test_other_customer_only_sees_the_company(self, client, admin, party, bad):
        _cust, comp = party
        other = _mk_customer(client, admin, "Bea Diaz")
        levels = _levels(_review(client, admin, customer_id=other["id"],
                                 company_id=comp["id"], amount=100))
        assert "customer_bad_check" not in levels
        assert levels["company_bad_check"] == "approve"

    def test_closed_bad_check_is_quiet(self, client, admin, party, bad):
        cust, comp = party
        _pay(client, admin, bad["bad_check"]["id"], 525)
        levels = _levels(_review(client, admin, customer_id=cust["id"],
                                 company_id=comp["id"], amount=100))
        assert "customer_bad_check" not in levels
        assert "company_bad_check" not in levels


# ── The list ───────────────────────────────────────────────


class TestList:
    def test_filters_search_and_open_total(self, client, admin, party, bad):
        cust, comp = party
        other = _mk_customer(client, admin, "Bea Diaz")
        second = _cash(client, admin, other, comp, amount=100, check_number="77",
                       ack=["customer_bad_check", "company_bad_check"]).json()["check"]
        b2 = _report(client, admin, second["id"], fee=0,
                     reason="stop_payment").json()["bad_check"]
        _pay(client, admin, b2["id"], 100)
        everything = client.get(BAD, headers=admin).json()
        assert everything["total"] == 2
        assert (everything["open_count"], everything["open_owed"]) == (1, 525.0)
        open_only = client.get(f"{BAD}?status=open", headers=admin).json()
        assert [r["customer_name"] for r in open_only["rows"]] == [cust["full_name"]]
        paid = client.get(f"{BAD}?status=paid", headers=admin).json()
        assert [r["check_number"] for r in paid["rows"]] == ["77"]
        found = client.get(f"{BAD}?q=bea", headers=admin).json()
        assert [r["id"] for r in found["rows"]] == [b2["id"]]
        one_letter = client.get(f"{BAD}?q=b", headers=admin).json()
        assert one_letter["total"] == 2
        assert client.get(f"{BAD}?status=bounced", headers=admin).status_code == 422

    def test_detail(self, client, admin, cashier, bad):
        bid = bad["bad_check"]["id"]
        out = client.get(f"{BAD}/{bid}", headers=cashier).json()
        assert out["bad_check"]["id"] == bid
        assert out["check"]["bad_check"]["id"] == bid
        assert (out["can_pay"], out["can_write_off"]) == (True, False)
        assert client.get(f"{BAD}/99999", headers=admin).status_code == 404


# ── Gates ───────────────────────────────────────────────────


class TestGates:
    ROUTES = (
        ("get", "/bad-checks", None),
        ("get", "/bad-checks/1", None),
        ("post", "/checks/1/bad-check", {"reason": "nsf", "returned_on": TODAY}),
        ("post", "/bad-checks/1/payments", {"amount": 1}),
        ("post", "/bad-checks/1/write-off", {"note": "x"}),
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
            assert "not turned on" in resp.json()["detail"]

    def test_refused_without_rights(self, client, on):
        nobody, _ = _employee(client, on, "cc_bad_gate",
                              {"time_clock": {"read": True}})
        for method, path, body in self.ROUTES:
            assert self._call(client, method, path, body, nobody).status_code == 403

    def test_accountant_refused(self, client, on):
        from api.Modules.Tenancy.Models import User
        with db_session():
            u = User(store_id=on, username="cc-bad-acct@x.com",
                     full_name="Acct", role="accountant")
            u.set_password("acctpass1234")
            db.session.add(u)
            db.session.commit()
        h = _h(login_employee(client, on, "cc-bad-acct@x.com", "acctpass1234"))
        for method, path, body in self.ROUTES:
            assert self._call(client, method, path, body, h).status_code == 403

    def test_another_computer_is_locked_out(self, client, admin, on):
        from tests.conftest import _starlette_client
        _starlette_client.cookies.clear()
        h = _h(login_admin(client, on))
        for method, path, body in self.ROUTES:
            resp = self._call(client, method, path, body, h)
            assert resp.status_code == 403, path
            assert "not activated" in resp.json()["detail"] or "locked" in resp.json()["detail"]

    def test_signed_out(self, client, on):
        for method, path, body in self.ROUTES:
            assert self._call(client, method, path, body, None).status_code == 401


# ── Purge ───────────────────────────────────────────────────


def test_bad_checks_purge_before_checks():
    from api.Modules.Billing.Services.retention import _store_owned_models
    from api.Modules.CheckCashing.Models import (
        BadCheck, BadCheckPayment, CashedCheck,
    )
    pairs = _store_owned_models()
    assert (pairs.index((BadCheckPayment, "store_id"))
            < pairs.index((BadCheck, "store_id"))
            < pairs.index((CashedCheck, "store_id")))


def test_purge_keeps_a_sibling_stores_bad_checks(client, admin, on, party, bad):
    """Store A cashed a check that bounced and took a payback for a
    bad check of sibling B; B took a payback for A's bad check.
    Purging A removes A's bad check with both its paybacks, and B's
    bad check keeps the payback A took (now B's)."""
    from datetime import timedelta as td

    from api.Core.Clock import utc_now
    from api.Modules.Billing.Services.retention import purge_expired_stores
    from api.Modules.CheckCashing.Models import BadCheck, BadCheckPayment
    from api.Modules.Tenancy.Models import Store
    cust, comp = party
    a_bad = bad["bad_check"]["id"]
    sibling = _new_store("cc-bad-purge-sib")
    _flag(sibling, True)
    _link_owner(on, sibling)
    h = _h(login_admin(client, sibling))
    from tests.conftest import _starlette_client
    _starlette_client.cookies.clear()
    _activate(client, h)
    ack = ["customer_bad_check", "company_bad_check", "cashed_today"]
    b_check = _cash(client, h, cust, comp, amount=100, check_number="9",
                    ack=ack).json()["check"]
    b_bad = _report(client, h, b_check["id"], fee=0).json()["bad_check"]["id"]
    assert _pay(client, h, a_bad, 10).status_code == 201
    _starlette_client.cookies.clear()
    a = _h(login_admin(client, on))
    _activate(client, a)
    assert _pay(client, a, b_bad, 20).status_code == 201
    with db_session():
        store = db.session.get(Store, on)
        store.plan = "inactive"
        store.data_retention_until = utc_now() - td(days=1)
        db.session.commit()
        assert purge_expired_stores(db.session) == 1
        assert [b.id for b in db.session.query(BadCheck)] == [b_bad]
        left = db.session.query(BadCheckPayment).all()
        assert [(p.bad_check_id, p.store_id, p.amount_cents) for p in left] == [
            (b_bad, sibling, 2000)]
        assert left[0].created_by is None
