"""Check cashing module, PR 1: settings, customers (with IDs) and
companies — api/Modules/CheckCashing/INVARIANTS.md.

The rules under test:
  * opt-in: every route answers 403 until the store's ``check_desk``
    flag is on, and the flag reaches the SPA's ``features`` list;
  * rights: ``check_cashing.read/create/update`` for the lists and
    profiles (employees by default), the single switch
    ``check_cashing_manage.update`` (Admin by default, grantable and
    revocable) for settings, block / trust and an own fee;
  * a customer is born with at least one ID and never loses the last;
  * companies: valid ABA routing number, routing + account unique in
    the owner umbrella;
  * owner-umbrella sharing, and isolation from unrelated stores;
  * every change writes an operator-audit row.
"""
import pytest

from urllib.parse import urlencode

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee, make_employee_client

BASE = "/api/v2/check-cashing"
# Valid ABA routing numbers (check digit holds).
ROUTING = "111000025"
ROUTING_2 = "021000021"


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _flag(store_id, on=True):
    from api.Modules.Billing.Models import StoreFeatureOverride
    with db_session():
        row = db.session.query(StoreFeatureOverride).filter_by(
            store_id=store_id, flag_key="check_desk",
        ).first()
        if row is None:
            db.session.add(StoreFeatureOverride(
                store_id=store_id, flag_key="check_desk", enabled=on,
            ))
        else:
            row.enabled = on
        db.session.commit()


def _new_store(slug):
    from api.Modules.Tenancy.Models import Store, User
    with db_session():
        s = Store(name=f"Store {slug}", slug=slug, email=f"{slug}@x.com",
                  plan="basic")
        db.session.add(s)
        db.session.flush()
        u = User(store_id=s.id, username=f"admin-{slug}@x.com",
                 full_name="Admin", role="admin")
        u.set_password("testpass123!")
        db.session.add(u)
        db.session.commit()
        return s.id


def _link_owner(*store_ids):
    from api.Modules.Tenancy.Models import StoreOwnerLink, User
    with db_session():
        u = User(store_id=None, username="cc-owner@x.com",
                 email="cc-owner@x.com", full_name="Owner", role="owner")
        u.set_password("ownerpass123")
        db.session.add(u)
        db.session.flush()
        for sid in store_ids:
            db.session.add(StoreOwnerLink(owner_id=u.id, store_id=sid))
        db.session.commit()


def _employee(client, sid, username, matrix):
    from api.Core.Permissions import set_user_permissions
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=sid, username=username, role="employee",
                 is_active=True)
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()
        uid = u.id
    set_user_permissions(sid, uid, matrix)
    return _h(login_employee(client, sid, username, "emppass1234")), uid


@pytest.fixture
def on(test_store_id):
    _flag(test_store_id, True)
    return test_store_id


@pytest.fixture
def admin(client, on):
    return _h(login_admin(client, on))


@pytest.fixture
def cashier(on):
    c, jwt = make_employee_client(on, username_suffix="cashier")
    return _h(jwt)


def _customer_body(name="Ana Lopez", **over):
    body = {
        "full_name": name, "phone_number": "(713) 555-0101",
        "ids": [{"id_type": "drivers_license", "id_number": "D1234567",
                 "issuer": "TX", "expires_on": "2030-01-31"}],
    }
    body.update(over)
    return body


def _mk_customer(client, h, name="Ana Lopez", **over):
    resp = client.post(f"{BASE}/customers", headers=h,
                       json=_customer_body(name, **over))
    assert resp.status_code == 201, resp.text
    return resp.json()["customer"]


def _company_body(name="PD Electric LLC", **over):
    body = {"name": name, "routing_number": ROUTING,
            "account_number": "123456789"}
    body.update(over)
    return body


def _mk_company(client, h, name="PD Electric LLC", **over):
    resp = client.post(f"{BASE}/companies", headers=h,
                       json=_company_body(name, **over))
    assert resp.status_code == 201, resp.text
    return resp.json()["company"]


def _audit_actions(store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        return [
            r.action for r in db.session.query(OperatorAuditLog)
            .filter_by(store_id=store_id).order_by(OperatorAuditLog.id)
        ]


# ── The switch ──────────────────────────────────────────────


class TestOptIn:
    def test_every_route_is_refused_while_off(self, client, test_store_id):
        h = _h(login_admin(client, test_store_id))
        for method, path, body in (
            ("get", "/settings", None),
            ("put", "/settings", {"default_fee_kind": "percent",
                                  "default_fee_value": 1}),
            ("get", "/customers", None),
            ("post", "/customers", _customer_body()),
            ("get", "/customers/1", None),
            ("get", "/companies", None),
            ("post", "/companies", _company_body()),
            ("get", "/companies/1", None),
        ):
            resp = getattr(client, method)(BASE + path, headers=h, json=body) \
                if body is not None else getattr(client, method)(BASE + path, headers=h)
            assert resp.status_code == 403, (method, path, resp.text)
            assert "not turned on" in resp.json()["detail"]

    def test_off_by_default_and_declared(self):
        from api.Core.Bootstrap import DEFAULT_FEATURE_FLAGS
        row = [f for f in DEFAULT_FEATURE_FLAGS if f[0] == "check_desk"]
        assert row and row[0][3] is False

    def test_turning_off_again_closes_it(self, client, admin, on):
        assert client.get(f"{BASE}/customers", headers=admin).status_code == 200
        _flag(on, False)
        assert client.get(f"{BASE}/customers", headers=admin).status_code == 403

    def test_session_features_carry_the_flag_only_when_on(
        self, client, test_store_id,
    ):
        h = _h(login_admin(client, test_store_id))
        url = "/api/v2/auth/session-status"
        assert "check_desk" not in client.get(url, headers=h).json()["features"]
        _flag(test_store_id, True)
        assert "check_desk" in client.get(url, headers=h).json()["features"]

    def test_a_person_module_list_does_not_hide_it(self, client, on):
        """``module_access`` predates the module: it must not hide it."""
        from api.Modules.Tenancy.Models import User
        c, jwt = make_employee_client(on, username_suffix="limited")
        with db_session():
            u = db.session.query(User).filter(
                User.username.like("limited_%"),
            ).first()
            u.module_access = "module_lottery"
            db.session.commit()
        features = client.get(
            "/api/v2/auth/session-status", headers=_h(jwt),
        ).json()["features"]
        assert "check_desk" in features
        assert "module_money_services" not in features

    def test_unrelated_flag_stays_untouched(self, client, admin):
        """The old module_check_cashing (Returned checks) is a different
        switch and stays on."""
        features = client.get(
            "/api/v2/auth/session-status", headers=admin,
        ).json()["features"]
        assert "module_check_cashing" in features


# ── Rights ──────────────────────────────────────────────────


class TestRights:
    def test_defaults(self):
        from api.Core.Permissions import RBAC_DEFAULTS, actions_for
        assert actions_for("check_cashing") == ["create", "read", "update"]
        assert actions_for("check_cashing_manage") == ["update"]
        for perm in ("check_cashing.create", "check_cashing.read",
                     "check_cashing.update", "check_cashing_manage.update"):
            assert perm in RBAC_DEFAULTS["admin"]
        for perm in ("check_cashing.create", "check_cashing.read",
                     "check_cashing.update"):
            assert perm in RBAC_DEFAULTS["employee"]
        assert "check_cashing_manage.update" not in RBAC_DEFAULTS["employee"]
        assert "check_cashing.read" in RBAC_DEFAULTS["owner"]
        assert "check_cashing_manage.update" not in RBAC_DEFAULTS["owner"]
        assert "check_cashing.delete" not in RBAC_DEFAULTS["admin"]

    def test_seeded_once_for_existing_databases(self):
        from api.Core.Boot import LATER_RESOURCES
        assert "check_cashing" in LATER_RESOURCES
        assert "check_cashing_manage" in LATER_RESOURCES

    def test_no_rights_no_access(self, client, on):
        nobody, _ = _employee(client, on, "cc_none",
                              {"time_clock": {"read": True}})
        assert client.get(f"{BASE}/customers", headers=nobody).status_code == 403
        assert client.get(f"{BASE}/companies", headers=nobody).status_code == 403
        assert client.get(f"{BASE}/settings", headers=nobody).status_code == 403
        assert client.post(f"{BASE}/customers", headers=nobody,
                           json=_customer_body()).status_code == 403

    def test_read_only_cannot_write(self, client, admin, on):
        cust = _mk_customer(client, admin)
        reader, _ = _employee(client, on, "cc_read",
                              {"check_cashing": {"read": True}})
        assert client.get(f"{BASE}/customers", headers=reader).status_code == 200
        assert client.get(f"{BASE}/customers/{cust['id']}",
                          headers=reader).status_code == 200
        assert client.post(f"{BASE}/customers", headers=reader,
                           json=_customer_body("B")).status_code == 403
        assert client.put(f"{BASE}/customers/{cust['id']}", headers=reader,
                          json={"full_name": "X"}).status_code == 403
        assert client.post(f"{BASE}/companies", headers=reader,
                           json=_company_body()).status_code == 403
        assert client.post(
            f"{BASE}/customers/{cust['id']}/ids", headers=reader,
            json={"id_type": "passport", "id_number": "P1"},
        ).status_code == 403

    def test_cashier_adds_and_edits_but_cannot_block_or_set_fee(
        self, client, cashier,
    ):
        cust = _mk_customer(client, cashier)
        assert cust["status"] == "normal"
        put = client.put(f"{BASE}/customers/{cust['id']}", headers=cashier,
                         json={"full_name": "Ana M. Lopez"})
        assert put.status_code == 200
        assert put.json()["customer"]["full_name"] == "Ana M. Lopez"
        for over in ({"status": "blocked"}, {"status": "trusted"},
                     {"fee_kind": "percent", "fee_value": 1}):
            resp = client.post(f"{BASE}/customers", headers=cashier,
                               json=_customer_body("C", **over))
            assert resp.status_code == 403, over
            resp = client.put(f"{BASE}/customers/{cust['id']}", headers=cashier,
                              json={"full_name": "Ana", **over})
            assert resp.status_code == 403, over
            resp = client.post(f"{BASE}/companies", headers=cashier,
                               json=_company_body(**over))
            assert resp.status_code == 403, over
        comp = _mk_company(client, cashier)
        assert client.put(f"{BASE}/companies/{comp['id']}", headers=cashier,
                          json=_company_body(status="blocked")).status_code == 403
        assert client.put(f"{BASE}/settings", headers=cashier, json={
            "default_fee_kind": "percent", "default_fee_value": 1,
        }).status_code == 403
        # Reading the settings is fine (the fee is shown at the counter).
        assert client.get(f"{BASE}/settings", headers=cashier).status_code == 200

    def test_cashier_edit_keeps_manager_values(self, client, admin, cashier):
        """A cashier fixing a phone number leaves the Admin's block and
        fee alone — no manage right needed when they do not change."""
        cust = _mk_customer(client, admin, status="blocked",
                            status_reason="Bounced", fee_kind="flat",
                            fee_value=5)
        body = {"full_name": "Ana", "phone_number": "7135550199",
                "status": "blocked", "status_reason": "Bounced",
                "fee_kind": "flat", "fee_value": 5}
        resp = client.put(f"{BASE}/customers/{cust['id']}", headers=cashier,
                          json=body)
        assert resp.status_code == 200, resp.text
        assert resp.json()["customer"]["status"] == "blocked"

    def test_manage_switch_is_grantable_and_revocable(self, client, on):
        from api.Core.Permissions import set_user_permissions
        base = {"check_cashing": {"create": True, "read": True, "update": True}}
        emp, uid = _employee(client, on, "cc_mgr", base)
        cust = _mk_customer(client, emp)
        block = {"full_name": "Ana", "status": "blocked",
                 "status_reason": "Fraud"}
        url = f"{BASE}/customers/{cust['id']}"
        assert client.put(url, headers=emp, json=block).status_code == 403
        set_user_permissions(on, uid, {**base,
                                       "check_cashing_manage": {"update": True}})
        assert client.put(url, headers=emp, json=block).status_code == 200
        set_user_permissions(on, uid, base)
        assert client.put(url, headers=emp, json={
            "full_name": "Ana", "status": "normal",
        }).status_code == 403

    def test_accountant_is_refused(self, client, on):
        from api.Modules.Tenancy.Models import User
        with db_session():
            u = User(store_id=on, username="cc-acct@x.com",
                     full_name="Acct", role="accountant")
            u.set_password("acctpass1234")
            db.session.add(u)
            db.session.commit()
        h = _h(login_employee(client, on, "cc-acct@x.com", "acctpass1234"))
        assert client.get(f"{BASE}/customers", headers=h).status_code == 403

    def test_signed_out_is_refused(self, client, on):
        assert client.get(f"{BASE}/customers").status_code == 401


# ── Settings ────────────────────────────────────────────────


class TestSettings:
    def test_defaults_before_saving(self, client, admin):
        data = client.get(f"{BASE}/settings", headers=admin).json()
        assert data == {
            "default_fee_kind": "percent", "default_fee_value": 0.0,
            "base_charge": None, "base_charge_under": None,
            "expired_id_mode": "warn", "daily_limit": None,
        }

    def test_save_roundtrip_and_audit(self, client, admin, on):
        body = {"default_fee_kind": "percent", "default_fee_value": 1.25,
                "base_charge": 3, "base_charge_under": 100,
                "expired_id_mode": "block"}
        resp = client.put(f"{BASE}/settings", headers=admin, json=body)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {**body, "default_fee_value": 1.25,
                               "base_charge": 3.0, "base_charge_under": 100.0,
                               "daily_limit": None}
        assert client.get(f"{BASE}/settings", headers=admin).json()[
            "expired_id_mode"] == "block"
        from api.Modules.CheckCashing.Models import CheckCashingSettings
        with db_session():
            row = db.session.query(CheckCashingSettings).filter_by(
                store_id=on).one()
            assert row.default_fee_value == 125
            assert row.base_charge_cents == 300
        # Saving again updates the same row.
        body["default_fee_kind"] = "flat"
        body["default_fee_value"] = 5
        assert client.put(f"{BASE}/settings", headers=admin,
                          json=body).status_code == 200
        with db_session():
            assert db.session.query(CheckCashingSettings).filter_by(
                store_id=on).count() == 1
        assert _audit_actions(on).count("update_check_cashing_settings") == 2

    @pytest.mark.parametrize("body", [
        {"default_fee_kind": "percent", "default_fee_value": 101},
        {"default_fee_kind": "flat", "default_fee_value": 10_001},
        {"default_fee_kind": "percent", "default_fee_value": -1},
        {"default_fee_kind": "other", "default_fee_value": 1},
        {"default_fee_kind": "percent", "default_fee_value": 1,
         "base_charge": 3},
        {"default_fee_kind": "percent", "default_fee_value": 1,
         "base_charge_under": 100},
        {"default_fee_kind": "percent", "default_fee_value": 1,
         "expired_id_mode": "ignore"},
        {"default_fee_kind": "percent", "default_fee_value": 1, "extra": 1},
    ])
    def test_rejects_bad_values(self, client, admin, body):
        assert client.put(f"{BASE}/settings", headers=admin,
                          json=body).status_code == 422


# ── Customers ───────────────────────────────────────────────


class TestCustomers:
    def test_create_detail_and_audit(self, client, admin, on):
        cust = _mk_customer(client, admin, dob="1990-04-02",
                            address="12 Main St", notes="Regular")
        assert cust["phone_number"] == "7135550101"
        assert cust["ids"][0]["id_number"] == "D1234567"
        assert cust["ids"][0]["expired"] is False
        assert cust["home_store_name"]
        got = client.get(f"{BASE}/customers/{cust['id']}", headers=admin)
        assert got.json()["customer"] == cust
        assert "create_check_customer" in _audit_actions(on)

    def test_needs_at_least_one_id(self, client, admin):
        resp = client.post(f"{BASE}/customers", headers=admin,
                           json=_customer_body(ids=[]))
        assert resp.status_code == 422
        body = _customer_body()
        del body["ids"]
        assert client.post(f"{BASE}/customers", headers=admin,
                           json=body).status_code == 422

    def test_rejects_bad_fields(self, client, admin):
        for over in ({"full_name": ""}, {"status": "vip"},
                     {"fee_kind": "percent"}, {"fee_value": 2},
                     {"fee_kind": "percent", "fee_value": 150},
                     {"ids": [{"id_type": "library_card", "id_number": "1"}]},
                     {"ids": [{"id_type": "passport", "id_number": ""}]}):
            resp = client.post(f"{BASE}/customers", headers=admin,
                               json=_customer_body(**over))
            assert resp.status_code == 422, over

    def test_admin_blocks_trusts_and_sets_fee(self, client, admin, on):
        cust = _mk_customer(client, admin)
        url = f"{BASE}/customers/{cust['id']}"
        resp = client.put(url, headers=admin, json={
            "full_name": "Ana Lopez", "status": "blocked",
            "status_reason": "Bounced two checks",
        })
        assert resp.json()["customer"]["status"] == "blocked"
        resp = client.put(url, headers=admin, json={
            "full_name": "Ana Lopez", "status": "trusted",
            "status_reason": "Regular for years",
            "fee_kind": "percent", "fee_value": 0.5,
        })
        data = resp.json()["customer"]
        assert data["status"] == "trusted"
        assert data["fee_kind"] == "percent" and data["fee_value"] == 0.5
        resp = client.put(url, headers=admin, json={
            "full_name": "Ana Lopez", "status": "normal",
            "status_reason": "left over",
        })
        # Back to normal clears the reason.
        assert resp.json()["customer"]["status_reason"] == ""
        actions = _audit_actions(on)
        for action in ("block_check_customer", "trust_check_customer",
                       "unblock_check_customer"):
            assert action in actions

    def test_expired_id_is_flagged(self, client, admin):
        cust = _mk_customer(client, admin, ids=[
            {"id_type": "passport", "id_number": "P998877",
             "issuer": "Mexico", "expires_on": "2001-01-01"},
        ])
        assert cust["ids"][0]["expired"] is True
        row = client.get(f"{BASE}/customers", headers=admin).json()["rows"][0]
        assert row["has_expired_id"] is True
        assert row["id_summary"] == "••••8877"

    def test_ids_add_edit_and_keep_the_last(self, client, admin, on):
        cust = _mk_customer(client, admin)
        url = f"{BASE}/customers/{cust['id']}/ids"
        first = cust["ids"][0]["id"]
        # The only ID cannot go.
        resp = client.delete(f"{url}/{first}", headers=admin)
        assert resp.status_code == 409
        added = client.post(url, headers=admin, json={
            "id_type": "passport", "id_number": "G12345678",
            "issuer": "Mexico", "expires_on": "2031-05-01",
        })
        assert added.status_code == 201, added.text
        ids = added.json()["customer"]["ids"]
        assert [i["id_type"] for i in ids] == ["drivers_license", "passport"]
        second = ids[1]["id"]
        edited = client.put(f"{url}/{second}", headers=admin, json={
            "id_type": "passport", "id_number": "G12345679",
            "issuer": "Mexico",
        })
        assert edited.json()["customer"]["ids"][1]["id_number"] == "G12345679"
        resp = client.delete(f"{url}/{first}", headers=admin)
        assert resp.status_code == 200
        assert [i["id"] for i in resp.json()["customer"]["ids"]] == [second]
        assert client.delete(f"{url}/{999999}", headers=admin).status_code == 404
        actions = _audit_actions(on)
        for action in ("add_check_customer_id", "update_check_customer_id",
                       "delete_check_customer_id"):
            assert action in actions

    def test_at_most_ten_ids(self, client, admin):
        cust = _mk_customer(client, admin, ids=[
            {"id_type": "other", "id_number": str(n)} for n in range(10)
        ])
        resp = client.post(f"{BASE}/customers/{cust['id']}/ids", headers=admin,
                           json={"id_type": "other", "id_number": "11"})
        assert resp.status_code == 409

    def test_id_of_another_customer_is_not_found(self, client, admin):
        a = _mk_customer(client, admin, "A")
        b = _mk_customer(client, admin, "B")
        b_id = b["ids"][0]["id"]
        resp = client.put(f"{BASE}/customers/{a['id']}/ids/{b_id}",
                          headers=admin,
                          json={"id_type": "passport", "id_number": "X"})
        assert resp.status_code == 404

    def test_list_search_filter_sort_and_page(self, client, admin):
        _mk_customer(client, admin, "Carlos Diaz", phone_number="8325550000",
                     ids=[{"id_type": "state_id", "id_number": "S5551234"}])
        _mk_customer(client, admin, "Ana Lopez")
        _mk_customer(client, admin, "Beto Ruiz", status="blocked")
        url = f"{BASE}/customers"
        names = [r["full_name"] for r in
                 client.get(url, headers=admin).json()["rows"]]
        assert names == ["Ana Lopez", "Beto Ruiz", "Carlos Diaz"]
        for q in ("carlos", "832555", "S5551234"):
            rows = client.get(f"{url}?{urlencode({'q': q})}", headers=admin).json()["rows"]
            assert [r["full_name"] for r in rows] == ["Carlos Diaz"], q
        rows = client.get(f"{url}?{urlencode({'status': 'blocked'})}", headers=admin).json()["rows"]
        assert [r["full_name"] for r in rows] == ["Beto Ruiz"]
        rows = client.get(f"{url}?{urlencode({'sort': 'name', 'dir': 'desc'})}", headers=admin).json()["rows"]
        assert rows[0]["full_name"] == "Carlos Diaz"
        page = client.get(f"{url}?{urlencode({'per_page': 2, 'page': 2})}", headers=admin).json()
        assert page["total"] == 3 and page["total_pages"] == 2
        assert len(page["rows"]) == 1
        assert client.get(f"{url}?{urlencode({'status': 'vip'})}", headers=admin).status_code == 422

    def test_missing_customer_404(self, client, admin):
        assert client.get(f"{BASE}/customers/999999",
                          headers=admin).status_code == 404
        assert client.put(f"{BASE}/customers/999999", headers=admin,
                          json={"full_name": "X"}).status_code == 404


# ── Companies ───────────────────────────────────────────────


class TestCompanies:
    def test_create_detail_list_and_audit(self, client, admin, on):
        comp = _mk_company(client, admin, phone="512-555-0100")
        assert comp["routing_number"] == ROUTING
        assert comp["account_number"] == "123456789"
        got = client.get(f"{BASE}/companies/{comp['id']}", headers=admin)
        assert got.json()["company"] == comp
        row = client.get(f"{BASE}/companies", headers=admin).json()["rows"][0]
        assert row["account_last4"] == "6789"
        assert "account_number" not in row
        assert "create_check_company" in _audit_actions(on)

    def test_company_without_numbers_is_allowed(self, client, admin):
        comp = _mk_company(client, admin, "City of Houston",
                           routing_number="", account_number="")
        assert comp["routing_number"] == ""

    def test_numbers_rules(self, client, admin):
        url = f"{BASE}/companies"
        bad_digit = client.post(url, headers=admin,
                                json=_company_body(routing_number="111000026"))
        assert bad_digit.status_code == 409
        assert "routing number" in bad_digit.json()["detail"]
        for over in ({"routing_number": "12345"},
                     {"routing_number": "abcdefghi"},
                     {"account_number": "12-34"},
                     {"account_number": ""},
                     {"routing_number": ""},
                     {"name": ""}):
            assert client.post(url, headers=admin,
                               json=_company_body(**over)).status_code == 422, over

    def test_same_numbers_twice_conflict(self, client, admin):
        first = _mk_company(client, admin)
        resp = client.post(f"{BASE}/companies", headers=admin,
                           json=_company_body("Someone else"))
        assert resp.status_code == 409
        assert "PD Electric LLC" in resp.json()["detail"]
        # Same routing, other account is a different company.
        _mk_company(client, admin, "Other", account_number="999")
        # Editing a company keeps its own numbers.
        resp = client.put(f"{BASE}/companies/{first['id']}", headers=admin,
                          json=_company_body("PD Electric"))
        assert resp.status_code == 200
        # …but cannot take another company's numbers.
        resp = client.put(f"{BASE}/companies/{first['id']}", headers=admin,
                          json=_company_body(account_number="999"))
        assert resp.status_code == 409

    def test_block_and_fee_audit(self, client, admin, on):
        comp = _mk_company(client, admin)
        resp = client.put(f"{BASE}/companies/{comp['id']}", headers=admin,
                          json=_company_body(status="blocked",
                                             status_reason="Stop payments",
                                             fee_kind="flat", fee_value=4.5))
        data = resp.json()["company"]
        assert data["status"] == "blocked"
        assert data["fee_kind"] == "flat" and data["fee_value"] == 4.5
        assert "block_check_company" in _audit_actions(on)

    def test_search_and_filter(self, client, admin):
        _mk_company(client, admin, "PD Electric LLC")
        _mk_company(client, admin, "Acme Payroll", routing_number=ROUTING_2,
                    account_number="5550001", status="trusted")
        url = f"{BASE}/companies"
        for q, name in (("acme", "Acme Payroll"), ("0210", "Acme Payroll"),
                        ("5550", "Acme Payroll"), ("electric", "PD Electric LLC")):
            rows = client.get(f"{url}?{urlencode({'q': q})}", headers=admin).json()["rows"]
            assert [r["name"] for r in rows] == [name], q
        rows = client.get(f"{url}?{urlencode({'status': 'trusted'})}", headers=admin).json()["rows"]
        assert [r["name"] for r in rows] == ["Acme Payroll"]

    def test_missing_company_404(self, client, admin):
        assert client.get(f"{BASE}/companies/999999",
                          headers=admin).status_code == 404
        assert client.put(f"{BASE}/companies/999999", headers=admin,
                          json=_company_body()).status_code == 404


# ── Sharing and isolation ───────────────────────────────────


class TestScope:
    def test_unrelated_store_sees_nothing(self, client, admin):
        cust = _mk_customer(client, admin)
        comp = _mk_company(client, admin)
        other = _new_store("cc-other")
        _flag(other, True)
        h = _h(login_admin(client, other))
        assert client.get(f"{BASE}/customers", headers=h).json()["total"] == 0
        assert client.get(f"{BASE}/companies", headers=h).json()["total"] == 0
        assert client.get(f"{BASE}/customers/{cust['id']}",
                          headers=h).status_code == 404
        assert client.put(f"{BASE}/customers/{cust['id']}", headers=h,
                          json={"full_name": "X"}).status_code == 404
        assert client.post(f"{BASE}/customers/{cust['id']}/ids", headers=h,
                           json={"id_type": "other", "id_number": "1"},
                           ).status_code == 404
        assert client.get(f"{BASE}/companies/{comp['id']}",
                          headers=h).status_code == 404
        # The same numbers are free in an unrelated store.
        assert client.post(f"{BASE}/companies", headers=h,
                           json=_company_body()).status_code == 201

    def test_owner_umbrella_shares_customers_and_companies(
        self, client, admin, on,
    ):
        cust = _mk_customer(client, admin)
        _mk_company(client, admin)
        sibling = _new_store("cc-sibling")
        _flag(sibling, True)
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        rows = client.get(f"{BASE}/customers", headers=h).json()["rows"]
        assert [r["id"] for r in rows] == [cust["id"]]
        assert rows[0]["home_store_name"] != "Store cc-sibling"
        # A sibling cannot add the same company twice.
        assert client.post(f"{BASE}/companies", headers=h,
                           json=_company_body("Dup")).status_code == 409
        # And can update the shared profile.
        resp = client.put(f"{BASE}/customers/{cust['id']}", headers=h,
                          json={"full_name": "Ana L."})
        assert resp.status_code == 200

    def test_sibling_needs_its_own_switch(self, client, admin, on):
        _mk_customer(client, admin)
        sibling = _new_store("cc-sib-off")
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        assert client.get(f"{BASE}/customers", headers=h).status_code == 403


# ── Housekeeping ────────────────────────────────────────────


def test_purged_with_the_store():
    from api.Modules.Billing.Services.retention import (
        STORE_OWNED_MODELS, _store_owned_models,
    )
    from api.Modules.CheckCashing.Models import (
        CheckCashingSettings, CheckCompany, CheckCustomer, CheckCustomerId,
    )
    pairs = _store_owned_models()
    for model in (CheckCustomerId, CheckCustomer, CheckCompany,
                  CheckCashingSettings):
        assert model.__name__ in STORE_OWNED_MODELS
        assert (model, "store_id") in pairs
    # IDs go before the customers they point at.
    assert pairs.index((CheckCustomerId, "store_id")) < pairs.index(
        (CheckCustomer, "store_id"))


def test_purge_removes_rows(client, admin, on):
    from datetime import timedelta

    from api.Core.Clock import utc_now
    from api.Modules.Billing.Services.retention import purge_expired_stores
    from api.Modules.CheckCashing.Models import CheckCustomer, CheckCustomerId
    from api.Modules.Tenancy.Models import Store
    _mk_customer(client, admin)
    with db_session():
        store = db.session.get(Store, on)
        store.plan = "inactive"
        store.data_retention_until = utc_now() - timedelta(days=1)
        db.session.commit()
        assert purge_expired_stores(db.session) == 1
        assert db.session.query(CheckCustomer).count() == 0
        assert db.session.query(CheckCustomerId).count() == 0


@pytest.mark.parametrize("routing, ok", [
    ("111000025", True), ("021000021", True), ("011000015", True),
    ("111000026", False), ("12345678", False), ("abcdefghi", False),
])
def test_aba_check_digit(routing, ok):
    from api.Modules.CheckCashing.Services import aba_routing_valid
    assert aba_routing_valid(routing) is ok


def test_mask():
    from api.Modules.CheckCashing.Services import mask
    assert mask("D1234567") == "••••4567"
    assert mask("123") == "123"
    assert mask("") == ""
