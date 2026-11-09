"""Check cashing runs on one activated computer per store (owner,
2026-11-09) — api/Modules/CheckCashing/INVARIANTS.md ("One computer").

The rules under test:
  * every check cashing route refuses a request without the store's
    live computer key, even with a valid sign-in, and says why;
  * only the manage switch activates or switches off; a cashier can't;
  * activating another computer switches the old one off;
  * a phone cannot be activated;
  * the key is an httpOnly, SameSite=Strict cookie scoped to the check
    cashing API, one per store, stored only as a hash;
  * the back office is untouched, the superadmin is exempt (support);
  * every activation and switch-off is audited; devices purge with
    the store.
"""
import hashlib

import pytest

from tests._app import db, db_session
from tests.conftest import _starlette_client, login_admin, login_employee
from tests.Modules.CheckCashing.test_check_cashing import (  # noqa: F401
    BASE, _activate, _audit_actions, _employee, _flag, _h, _link_owner,
    _new_store, on,
)

DESKTOP = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130"}
PHONE = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148"}
GATED = (
    ("get", "/settings"), ("get", "/customers"), ("get", "/companies"),
    ("get", "/checks"), ("post", "/checks/review"),
)
CASHIER = {"check_cashing": {"create": True, "read": True, "update": True}}


def _call(client, method, path, h):
    if method == "post":
        return client.post(BASE + path, headers=h, json={"amount": 1})
    return client.get(BASE + path, headers=h)


def _new_computer():
    """Another browser: same sign-in, empty cookie jar."""
    _starlette_client.cookies.clear()


def _key(store_id):
    return _starlette_client.cookies.get(f"db_check_device_{store_id}")


@pytest.fixture
def manager(client, on):
    return _h(login_admin(client, on))


class TestLock:
    def test_nothing_works_before_activation(self, client, manager):
        for method, path in GATED:
            resp = _call(client, method, path, manager)
            assert resp.status_code == 403, path
            assert resp.json()["detail"] == "This computer is not activated for check cashing."
        state = client.get(f"{BASE}/device", headers=manager).json()
        assert state["state"] == "none" and state["name"] == ""

    def test_activated_computer_works(self, client, manager, on):
        out = _activate(client, manager, "Front counter")
        assert out["state"] == "this" and out["name"] == "Front counter"
        assert out["activated_by"] == "Test Admin"
        for method, path in GATED:
            assert _call(client, method, path, manager).status_code == 200, path
        assert client.get(f"{BASE}/device", headers=manager).json()["state"] == "this"
        assert _audit_actions(on)[-1] == "activate_check_device"

    def test_another_computer_is_locked_out(self, client, manager, on):
        _activate(client, manager, "Front counter")
        _new_computer()
        h = _h(login_admin(client, on))
        resp = client.get(f"{BASE}/customers", headers=h)
        assert resp.status_code == 403
        assert "locked to Front counter" in resp.json()["detail"]
        state = client.get(f"{BASE}/device", headers=h).json()
        assert (state["state"], state["name"]) == ("other", "Front counter")
        # The back office keeps working on that computer.
        assert client.get("/api/v2/auth/session-status", headers=h).status_code == 200

    def test_a_password_alone_is_not_enough(self, client, on):
        """A cashier signed in somewhere else cannot cash checks."""
        manager = _h(login_admin(client, on))
        _activate(client, manager)
        _new_computer()
        cashier, _ = _employee(client, on, "cc_dev_cash", CASHIER)
        assert client.get(f"{BASE}/customers", headers=cashier).status_code == 403

    def test_moving_it_switches_the_old_one_off(self, client, manager, on):
        _activate(client, manager, "Old PC")
        old_key = _key(on)
        _new_computer()
        h = _h(login_admin(client, on))
        out = _activate(client, h, "New PC")
        assert out["name"] == "New PC"
        assert client.get(f"{BASE}/customers", headers=h).status_code == 200
        # The old computer's key no longer opens anything.
        _new_computer()
        _starlette_client.cookies.set(
            f"db_check_device_{on}", old_key, path="/api/v2/check-cashing",
        )
        resp = client.get(f"{BASE}/customers", headers=h)
        assert resp.status_code == 403
        assert "locked to New PC" in resp.json()["detail"]
        from api.Modules.Audit.Models import OperatorAuditLog
        with db_session():
            row = db.session.query(OperatorAuditLog).filter_by(
                action="activate_check_device").order_by(OperatorAuditLog.id.desc()).first()
            assert "replaces Old PC" in row.summary

    def test_switch_off(self, client, manager, on):
        _activate(client, manager)
        resp = client.post(f"{BASE}/device/switch-off", headers=manager)
        assert resp.status_code == 200, resp.text
        assert resp.json()["state"] == "none"
        assert client.get(f"{BASE}/customers", headers=manager).status_code == 403
        assert _audit_actions(on)[-1] == "switch_off_check_device"
        assert client.post(f"{BASE}/device/switch-off", headers=manager).status_code == 409

    def test_one_key_per_store(self, client, manager, on):
        _activate(client, manager)
        sibling = _new_store("cc-dev-sib")
        _flag(sibling, True)
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        resp = client.get(f"{BASE}/customers", headers=h)
        assert resp.status_code == 403
        assert "not activated" in resp.json()["detail"]
        _activate(client, h, "Sibling PC")
        # Both stores can share the same computer, each with its own key.
        assert client.get(f"{BASE}/customers", headers=h).status_code == 200
        assert client.get(f"{BASE}/customers", headers=manager).status_code == 200


class TestActivation:
    def test_needs_the_manage_switch(self, client, manager, on):
        cashier, uid = _employee(client, on, "cc_dev_emp", CASHIER)
        resp = client.post(f"{BASE}/device/activate", headers=cashier,
                           json={"name": "Mine"})
        assert resp.status_code == 403
        _activate(client, manager)
        assert client.post(f"{BASE}/device/switch-off",
                           headers=cashier).status_code == 403
        # A cashier may still ask whether this is the computer.
        assert client.get(f"{BASE}/device", headers=cashier).json()["state"] == "this"
        from api.Core.Permissions import set_user_permissions
        set_user_permissions(on, uid, {**CASHIER, "check_cashing_manage": {"update": True}})
        assert client.post(f"{BASE}/device/activate", headers=cashier,
                           json={"name": "Counter 2"}).status_code == 200

    def test_a_phone_cannot_be_activated(self, client, manager):
        resp = client.post(f"{BASE}/device/activate", headers={**manager, **PHONE},
                           json={"name": "My phone"})
        assert resp.status_code == 409
        assert "desktop" in resp.json()["detail"]
        assert client.post(f"{BASE}/device/activate", headers={**manager, **DESKTOP},
                           json={"name": "PC"}).status_code == 200

    def test_needs_a_name(self, client, manager):
        for name in ("", "x" * 61):
            assert client.post(f"{BASE}/device/activate", headers=manager,
                               json={"name": name}).status_code == 422

    def test_the_key_is_a_scoped_httponly_cookie_stored_as_a_hash(
        self, client, manager, on,
    ):
        resp = client.post(f"{BASE}/device/activate", headers=manager,
                           json={"name": "PC"})
        cookie = resp.headers.get("set-cookie", "")
        assert cookie.startswith(f"db_check_device_{on}=")
        lowered = cookie.lower()
        assert "httponly" in lowered
        assert "samesite=strict" in lowered
        assert "path=/api/v2/check-cashing" in lowered
        key = _key(on)
        from api.Modules.CheckCashing.Models import CheckDevice
        with db_session():
            row = db.session.query(CheckDevice).one()
            assert row.token_hash == hashlib.sha256(key.encode()).hexdigest()
            assert key not in row.token_hash

    def test_last_seen_is_kept(self, client, manager, on):
        from datetime import timedelta

        from api.Modules.CheckCashing.Models import CheckDevice
        _activate(client, manager)
        with db_session():
            row = db.session.query(CheckDevice).one()
            row.last_seen_at = row.last_seen_at - timedelta(hours=1)
            db.session.commit()
            before = row.last_seen_at
        client.get(f"{BASE}/customers", headers=manager)
        with db_session():
            assert db.session.query(CheckDevice).one().last_seen_at > before


class TestGates:
    ROUTES = (("get", "/device"), ("post", "/device/activate"),
              ("post", "/device/switch-off"))

    def _hit(self, client, method, path, h):
        if path.endswith("activate"):
            return client.post(BASE + path, headers=h, json={"name": "PC"})
        return getattr(client, method)(BASE + path, headers=h)

    def test_refused_while_the_module_is_off(self, client, test_store_id):
        h = _h(login_admin(client, test_store_id))
        for method, path in self.ROUTES:
            resp = self._hit(client, method, path, h)
            assert resp.status_code == 403, path
            assert "not turned on" in resp.json()["detail"]

    def test_refused_without_rights_or_signed_out(self, client, on):
        nobody, _ = _employee(client, on, "cc_dev_none", {"time_clock": {"read": True}})
        for method, path in self.ROUTES:
            assert self._hit(client, method, path, nobody).status_code == 403, path
        _new_computer()  # drops the sign-in cookie too
        for method, path in self.ROUTES:
            assert self._hit(client, method, path, None).status_code == 401, path

    def test_accountant_refused(self, client, on):
        from api.Modules.Tenancy.Models import User
        with db_session():
            u = User(store_id=on, username="cc-dev-acct@x.com",
                     full_name="Acct", role="accountant")
            u.set_password("acctpass1234")
            db.session.add(u)
            db.session.commit()
        h = _h(login_employee(client, on, "cc-dev-acct@x.com", "acctpass1234"))
        for method, path in self.ROUTES:
            assert self._hit(client, method, path, h).status_code == 403, path

    def test_superadmin_is_exempt(self):
        from api.Modules.CheckCashing.Controllers import require_check_device
        assert require_check_device(
            request=None, db=None, claims={"role": "superadmin"},  # type: ignore[arg-type]
        ) is None


def test_devices_purge_with_the_store(client, manager, on):
    from datetime import timedelta

    from api.Core.Clock import utc_now
    from api.Modules.Billing.Services.retention import (
        _store_owned_models, purge_expired_stores,
    )
    from api.Modules.CheckCashing.Models import CheckDevice
    from api.Modules.Tenancy.Models import Store
    assert (CheckDevice, "store_id") in _store_owned_models()
    _activate(client, manager)
    with db_session():
        store = db.session.get(Store, on)
        store.plan = "inactive"
        store.data_retention_until = utc_now() - timedelta(days=1)
        db.session.commit()
        assert purge_expired_stores(db.session) == 1
        assert db.session.query(CheckDevice).count() == 0
