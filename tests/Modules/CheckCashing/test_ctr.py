"""Check cashing module, PR 6a: Currency Transaction Reports —
api/Modules/CheckCashing/INVARIANTS.md ("CTR").

The rules under test:
  * the line is the customer's cash paid out in one store day across
    the owner's stores with the same EIN: over $10,000 a CTR (15 days),
    with the Southwest Border order on from $1,000 (30 days);
  * at the counter a customer without the CTR details cannot be cashed
    (block) until they are saved; a refusal is still saved;
  * the cashing that crosses the line opens the report, later checks
    that day add to it, a same-day void can make it not needed, a filed
    report never changes;
  * the SSN / ITIN is stored encrypted, shown masked, revealed only to
    a manager (audited);
  * the list, the report and filing are the manager's; filing saves a
    14-digit BSA ID once; every change is audited;
  * the bell reminds the manager five days before the deadline.
"""
from datetime import date, timedelta

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin
from tests.Modules.CheckCashing.test_cash_a_check import (  # noqa: F401
    CHECKS, _cash, _levels, _review, _settings, party,
)
from tests.Modules.CheckCashing.test_check_cashing import (  # noqa: F401
    BASE, _activate, _audit_actions, _flag, _h, _link_owner, _mk_company,
    _mk_customer, _new_store, admin, cashier, on,
)

CTRS = f"{BASE}/ctrs"
TODAY = date.today()
DETAILS = {
    "dob": "1985-04-12", "tin_type": "ssn", "tin": "123-45-6789",
    "occupation": "Electrician", "address": "100 Main St",
    "city": "Houston", "state": "TX", "zip_code": "77002",
}
BIG = 10_500  # less the 2% fee: $10,290 cash, over the line


def _details(client, h, cust, **over):
    return client.put(f"{BASE}/customers/{cust['id']}/ctr-details",
                      headers=h, json={**DETAILS, **over})


def _ready(client, h, cust):
    resp = _details(client, h, cust)
    assert resp.status_code == 200, resp.text
    return resp.json()["customer"]


def _ctrs(client, h, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    resp = client.get(f"{CTRS}?{query}", headers=h)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _store_settings(client, h, **over):
    _settings(client, h, legal_name="Demo Cambio LLC", ein="123456789",
              street="1 Commerce St", city="Houston", state="TX",
              zip_code="77002", **over)


# ── At the counter ─────────────────────────────────────────


class TestCounter:
    def test_details_block_until_saved(self, client, admin, party):
        cust, comp = party
        r = _review(client, admin, customer_id=cust["id"],
                    company_id=comp["id"], amount=BIG)
        assert _levels(r)["ctr_due"] == "info"
        item = next(i for i in r["items"] if i["code"] == "ctr_details")
        assert item["level"] == "block"
        assert item["fields"] == [
            "dob", "tin", "occupation", "address", "city", "state", "zip_code",
        ]
        assert _cash(client, admin, cust, comp, amount=BIG).status_code == 409
        # A refusal is still saved.
        assert _cash(client, admin, cust, comp, amount=BIG, decision="decline",
                     reason="No SSN").status_code == 201
        _ready(client, admin, cust)
        r = _review(client, admin, customer_id=cust["id"],
                    company_id=comp["id"], amount=BIG)
        assert "ctr_details" not in _levels(r)
        assert _cash(client, admin, cust, comp, amount=BIG).status_code == 201

    def test_under_the_line_asks_nothing(self, client, admin, party):
        cust, comp = party
        r = _review(client, admin, customer_id=cust["id"],
                    company_id=comp["id"], amount=5_000)
        assert not {"ctr_due", "ctr_details", "gto_due"} & set(_levels(r))

    def test_cash_of_the_day_adds_up(self, client, admin, party):
        cust, comp = party
        _ready(client, admin, cust)
        assert _cash(client, admin, cust, comp, amount=6_000).status_code == 201
        r = _review(client, admin, customer_id=cust["id"], company_id=comp["id"],
                    check_number="1002", amount=6_000)
        ctr_item = next(i for i in r["items"] if i["code"] == "ctr_due")
        assert ctr_item["amount"] == 11_760.0  # 5,880 + 5,880


# ── Opening and keeping the report ─────────────────────────


class TestReport:
    def test_crossing_opens_it_and_later_checks_add(self, client, admin, on, party):
        cust, comp = party
        _ready(client, admin, cust)
        assert _cash(client, admin, cust, comp, amount=6_000).status_code == 201
        assert _ctrs(client, admin)["rows"] == []
        assert _cash(client, admin, cust, comp, amount=6_000, check_number="1002",
                     ack=["cashed_today"]).status_code == 201
        out = _ctrs(client, admin)
        [row] = out["rows"]
        assert (row["kind"], row["status"], row["cash"], row["check_count"]) == (
            "ctr", "to_file", 11_760.0, 2)
        assert row["due_on"] == (TODAY + timedelta(days=15)).isoformat()
        assert row["customer_name"] == cust["full_name"]
        assert out["counts"] == {"to_file": 1, "overdue": 0, "due_soon": 0}
        assert _cash(client, admin, cust, comp, amount=100, check_number="1003",
                     ack=["cashed_today"]).status_code == 201
        [row] = _ctrs(client, admin)["rows"]
        assert (row["cash"], row["check_count"]) == (11_858.0, 3)

    def test_void_under_the_line_makes_it_not_needed(self, client, admin, party):
        cust, comp = party
        _ready(client, admin, cust)
        check = _cash(client, admin, cust, comp, amount=BIG).json()["check"]
        assert len(_ctrs(client, admin)["rows"]) == 1
        resp = client.post(f"{CHECKS}/{check['id']}/void", headers=admin,
                           json={"reason": "Wrong amount"})
        assert resp.status_code == 200, resp.text
        assert _ctrs(client, admin)["rows"] == []
        [row] = _ctrs(client, admin, status="not_needed")["rows"]
        assert row["cash"] == 0.0

    def test_gto_from_one_thousand(self, client, admin, party):
        cust, comp = party
        _settings(client, admin, gto_enabled=True)
        _ready(client, admin, cust)
        r = _review(client, admin, customer_id=cust["id"],
                    company_id=comp["id"], amount=1_500)
        assert _levels(r)["gto_due"] == "info"
        assert _cash(client, admin, cust, comp, amount=1_500).status_code == 201
        [row] = _ctrs(client, admin)["rows"]
        assert row["kind"] == "gto"
        assert row["due_on"] == (TODAY + timedelta(days=30)).isoformat()
        detail = client.get(f"{CTRS}/{row['id']}", headers=admin).json()["ctr"]
        assert detail["gto_mark"] == "MSB0926GTO"

    def test_sibling_with_same_ein_adds_up(self, client, admin, on, party):
        cust, comp = party
        _store_settings(client, admin)
        _ready(client, admin, cust)
        assert _cash(client, admin, cust, comp, amount=6_000).status_code == 201
        sibling = _new_store("cc-ctr-sib")
        _flag(sibling, True)
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        _activate(client, h)
        _store_settings(client, h)
        r = _review(client, h, customer_id=cust["id"], company_id=comp["id"],
                    check_number="2001", amount=6_000)
        assert "ctr_due" in _levels(r)
        # Another EIN is another business: counted on its own.
        _settings(client, h, ein="987654321")
        r = _review(client, h, customer_id=cust["id"], company_id=comp["id"],
                    check_number="2001", amount=6_000)
        assert "ctr_due" not in _levels(r)


# ── Customer CTR details and the SSN ───────────────────────


class TestDetails:
    def test_saved_encrypted_and_masked(self, client, admin, on, party):
        cust, _comp = party
        out = _ready(client, admin, cust)
        assert (out["tin_type"], out["tin_masked"]) == ("ssn", "•••-••-6789")
        assert out["ctr_missing"] == []
        from api.Modules.CheckCashing.Models import CheckCustomer
        with db_session():
            row = db.session.get(CheckCustomer, cust["id"])
            assert row.tin_last4 == "6789"
            assert "123456789" not in row.tin_encrypted
            assert row.tin_encrypted
        assert _audit_actions(on)[-1] == "update_check_customer_ctr"
        # Empty keeps the number on file.
        again = _details(client, admin, cust, tin="", occupation="Plumber")
        assert again.status_code == 200, again.text
        assert again.json()["customer"]["tin_masked"] == "•••-••-6789"

    def test_number_needed_the_first_time(self, client, admin, party):
        cust, _comp = party
        assert _details(client, admin, cust, tin="").status_code == 409

    @pytest.mark.parametrize("over", [
        {"tin": "12345678"}, {"tin_type": "itin", "tin": "123456789"},
        {"tin_type": "passport"}, {"occupation": ""}, {"zip_code": "7"},
        {"country": "usa"}, {"gender": "x"}, {"dob": "soon"},
    ])
    def test_bad_bodies(self, client, admin, party, over):
        cust, _comp = party
        assert _details(client, admin, cust, **over).status_code == 422

    def test_foreign_number(self, client, admin, party):
        cust, _comp = party
        resp = _details(client, admin, cust, tin_type="foreign", tin="MX-AB12345",
                        country="MX")
        assert resp.status_code == 200, resp.text

    def test_cashier_fills_details_but_cannot_reveal(self, client, cashier, admin, party):
        cust, _comp = party
        assert _details(client, cashier, cust).status_code == 200
        resp = client.post(f"{BASE}/customers/{cust['id']}/reveal-tin", headers=cashier)
        assert resp.status_code == 403

    def test_manager_reveals_audited(self, client, admin, on, party):
        cust, _comp = party
        _ready(client, admin, cust)
        resp = client.post(f"{BASE}/customers/{cust['id']}/reveal-tin", headers=admin)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"tin_type": "ssn", "tin": "123456789"}
        assert _audit_actions(on)[-1] == "reveal_check_customer_tin"

    def test_reveal_nothing_on_file(self, client, admin, party):
        cust, _comp = party
        resp = client.post(f"{BASE}/customers/{cust['id']}/reveal-tin", headers=admin)
        assert resp.status_code == 404


class TestPii:
    def test_dedicated_key_still_reads_old_numbers(self, monkeypatch):
        from api.Modules.CheckCashing.Services import pii
        monkeypatch.delenv("CHECK_PII_KEY", raising=False)
        old = pii.encrypt("123456789")
        monkeypatch.setenv("CHECK_PII_KEY", "a-dedicated-key")
        new = pii.encrypt("987654321")
        assert pii.decrypt(old) == "123456789"
        assert pii.decrypt(new) == "987654321"
        monkeypatch.delenv("CHECK_PII_KEY")
        with pytest.raises(pii.PiiKeyMissing):
            pii.decrypt(new)
        assert pii.decrypt("") == ""
        assert pii.mask_tin("") == ""


# ── The list, the report and filing ────────────────────────


@pytest.fixture
def report(client, admin, party):
    cust, comp = party
    _ready(client, admin, cust)
    assert _cash(client, admin, cust, comp, amount=BIG).status_code == 201
    [row] = _ctrs(client, admin)["rows"]
    return row


class TestFiling:
    def test_detail_has_every_section(self, client, admin, report):
        detail = client.get(f"{CTRS}/{report['id']}", headers=admin).json()["ctr"]
        assert detail["filer"]["missing"] == [
            "legal_name", "ein", "street", "city", "state", "zip_code",
        ]
        person = detail["person"]
        assert (person["tin_masked"], person["occupation"], person["id_number"]) == (
            "•••-••-6789", "Electrician", "D1234567")
        assert person["missing"] == []
        [check] = detail["checks"]
        assert (check["amount"], check["fee"], check["cash"]) == (10_500.0, 210.0, 10_290.0)
        assert detail["gto_mark"] == ""

    def test_store_details_fill_the_filer(self, client, admin, report):
        _store_settings(client, admin, contact_name="Maria", contact_phone="7135550101")
        filer = client.get(f"{CTRS}/{report['id']}", headers=admin).json()["ctr"]["filer"]
        assert (filer["legal_name"], filer["ein"], filer["missing"]) == (
            "Demo Cambio LLC", "123456789", [])

    def test_file_once_with_bsa_id(self, client, admin, on, report):
        url = f"{CTRS}/{report['id']}/file"
        body = {"bsa_id": "31000123456789", "filed_on": TODAY.isoformat()}
        resp = client.post(url, headers=admin, json=body)
        assert resp.status_code == 200, resp.text
        row = resp.json()["ctr"]["row"]
        assert (row["status"], row["bsa_id"]) == ("filed", "31000123456789")
        assert resp.json()["ctr"]["filed_by"]
        assert _audit_actions(on)[-1] == "file_check_ctr"
        assert client.post(url, headers=admin, json=body).status_code == 409
        assert _ctrs(client, admin)["counts"]["to_file"] == 0
        assert len(_ctrs(client, admin, status="filed")["rows"]) == 1

    def test_filed_report_never_changes(self, client, admin, party, report):
        cust, comp = party
        client.post(f"{CTRS}/{report['id']}/file", headers=admin,
                    json={"bsa_id": "31000123456789", "filed_on": TODAY.isoformat()})
        assert _cash(client, admin, cust, comp, amount=50, check_number="1009",
                     ack=["cashed_today"]).status_code == 201
        [row] = _ctrs(client, admin, status="filed")["rows"]
        assert row["cash"] == report["cash"]

    @pytest.mark.parametrize("body,code", [
        ({"bsa_id": "123", "filed_on": TODAY.isoformat()}, 422),
        ({"bsa_id": "31000123456789",
          "filed_on": (TODAY + timedelta(days=1)).isoformat()}, 409),
        ({"bsa_id": "31000123456789",
          "filed_on": (TODAY - timedelta(days=1)).isoformat()}, 409),
    ])
    def test_bad_filing(self, client, admin, report, body, code):
        resp = client.post(f"{CTRS}/{report['id']}/file", headers=admin, json=body)
        assert resp.status_code == code

    def test_cashier_cannot_see_or_file(self, client, cashier, report):
        assert client.get(CTRS, headers=cashier).status_code == 403
        assert client.get(f"{CTRS}/{report['id']}", headers=cashier).status_code == 403
        resp = client.post(f"{CTRS}/{report['id']}/file", headers=cashier,
                           json={"bsa_id": "31000123456789",
                                 "filed_on": TODAY.isoformat()})
        assert resp.status_code == 403

    def test_another_owner_cannot_see_it(self, client, report):
        other = _new_store("cc-ctr-other")
        _flag(other, True)
        h = _h(login_admin(client, other))
        _activate(client, h)
        assert client.get(f"{CTRS}/{report['id']}", headers=h).status_code == 404
        assert _ctrs(client, h)["rows"] == []

    def test_module_off(self, client, admin, on, report):
        _flag(on, False)
        assert client.get(CTRS, headers=admin).status_code == 403

    def test_search_by_name(self, client, admin, report):
        assert len(_ctrs(client, admin, q="ana")["rows"]) == 1
        assert _ctrs(client, admin, q="zz")["rows"] == []


# ── The bell ───────────────────────────────────────────────


def _bell_on(store_id):
    from api.Modules.Billing.Models import StoreFeatureOverride
    with db_session():
        db.session.add(StoreFeatureOverride(
            store_id=store_id, flag_key="notification_bell", enabled=True,
        ))
        db.session.commit()


def _due_in(ctr_id, days):
    from api.Modules.CheckCashing.Models import CtrReport
    with db_session():
        db.session.get(CtrReport, ctr_id).due_on = TODAY + timedelta(days=days)
        db.session.commit()


def _bell_kinds(client, h):
    resp = client.get("/api/v2/notifications/bell", headers=h)
    assert resp.status_code == 200, resp.text
    return {i["kind"]: i for i in resp.json()["items"]}


class TestBell:
    def test_five_days_before_then_overdue(self, client, admin, on, report):
        _bell_on(on)
        assert "check_cashing.ctr_due" not in _bell_kinds(client, admin)
        _due_in(report["id"], 5)
        item = _bell_kinds(client, admin)["check_cashing.ctr_due"]
        assert (item["urgency"], item["count"]) == ("due", 1)
        _due_in(report["id"], -1)
        assert _bell_kinds(client, admin)["check_cashing.ctr_due"]["urgency"] == "overdue"

    def test_gone_once_filed(self, client, admin, on, report):
        _bell_on(on)
        _due_in(report["id"], 1)
        client.post(f"{CTRS}/{report['id']}/file", headers=admin,
                    json={"bsa_id": "31000123456789", "filed_on": TODAY.isoformat()})
        assert "check_cashing.ctr_due" not in _bell_kinds(client, admin)

    def test_not_for_a_cashier(self, client, admin, cashier, on, report):
        _bell_on(on)
        _due_in(report["id"], 1)
        assert "check_cashing.ctr_due" not in _bell_kinds(client, cashier)

    def test_not_with_the_module_off(self, client, admin, on, report):
        _bell_on(on)
        _due_in(report["id"], 1)
        _flag(on, False)
        assert "check_cashing.ctr_due" not in _bell_kinds(client, admin)
