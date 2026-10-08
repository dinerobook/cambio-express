"""Impersonation is how support reproduces what a customer sees.

The SPA authenticates with the httpOnly ``db_access_token`` cookie
(PR #559), so an impersonation token that only comes back in the
JSON body never reaches the API: the browser keeps calling as the
superadmin while the chrome claims to be the customer. These tests
pin the whole loop: the cookie is set, the token says who is behind
it, the shell can see it, every operator action records the
superadmin, and the superadmin can step back out.
"""
from datetime import datetime

import jwt
import pytest

from tests._app import db, db_session
from tests.conftest import login_superadmin


@pytest.fixture
def sa_token(client):
    return login_superadmin(client)


@pytest.fixture
def sa_headers(sa_token):
    return {"Authorization": f"Bearer {sa_token}"}


def _mk_user(store_id, *, role="admin", active=True):
    from api.Modules.Tenancy.Models import User
    stamp = datetime.utcnow().timestamp()
    with db_session():
        u = User(
            username=f"imp-{role}-{store_id}-{stamp}@test.com",
            role=role, full_name="Imp Target", store_id=store_id,
            is_active=active,
        )
        u.set_password("targetpass123!")
        db.session.add(u)
        db.session.commit()
        return u.id


def _claims(token):
    return jwt.decode(token, options={"verify_signature": False})


def _superadmin_id():
    from api.Modules.Tenancy.Models import User
    with db_session():
        return db.session.query(User).filter_by(role="superadmin").first().id


def _impersonate(client, sa_headers, uid):
    resp = client.post(
        f"/api/v2/superadmin/impersonate/{uid}", headers=sa_headers,
    )
    assert resp.status_code == 200, resp.text
    return resp


class TestStart:
    def test_sets_the_access_cookie_the_spa_authenticates_with(
        self, client, sa_headers, test_store_id,
    ):
        uid = _mk_user(test_store_id)
        resp = _impersonate(client, sa_headers, uid)
        cookie = resp.headers.get("set-cookie", "")
        assert "db_access_token=" in cookie
        assert "HttpOnly" in cookie
        # The cookie carries the impersonation token, not the
        # superadmin's — the next cookie-only call is the customer.
        assert resp.json()["token"] in cookie

    def test_token_names_the_superadmin_behind_it(
        self, client, sa_headers, test_store_id,
    ):
        uid = _mk_user(test_store_id)
        claims = _claims(_impersonate(client, sa_headers, uid).json()["token"])
        assert claims["sub"] == str(uid) or claims["sub"] == uid
        assert int(claims["impersonated_by"]) == _superadmin_id()
        assert claims["impersonator_name"]

    def test_cookie_only_calls_run_as_the_customer(
        self, client, sa_headers, test_store_id,
    ):
        uid = _mk_user(test_store_id)
        _impersonate(client, sa_headers, uid)
        # No bearer header: exactly what the browser does.
        status = client.get("/api/v2/auth/session-status")
        assert status.status_code == 200, status.text
        body = status.json()
        assert body["store_name"] == "Test Store"
        assert body["impersonation"]["by_user_id"] == _superadmin_id()
        assert body["impersonation"]["by_name"]

    def test_plain_session_reports_no_impersonation(self, client, sa_headers):
        body = client.get(
            "/api/v2/auth/session-status", headers=sa_headers,
        ).json()
        assert body["impersonation"] is None

    def test_inactive_login_is_refused_with_a_reason(
        self, client, sa_headers, test_store_id,
    ):
        uid = _mk_user(test_store_id, active=False)
        resp = client.post(
            f"/api/v2/superadmin/impersonate/{uid}", headers=sa_headers,
        )
        assert resp.status_code == 409
        assert "enable" in resp.json()["detail"].lower()
        # Nothing was handed out.
        assert "db_access_token=" not in resp.headers.get("set-cookie", "")


class TestOperatorAuditTrail:
    def test_operator_audit_names_the_superadmin(self, test_store_id):
        from api.Core.Audit import audit_operator
        claims = {
            "sub": "42", "username": "cashier@test.com", "role": "admin",
            "store_id": test_store_id,
            "impersonated_by": _superadmin_id(),
            "impersonator_name": "Platform Admin",
        }
        with db_session():
            row = audit_operator(
                db.session, claims, action="update_settings",
                target_type="store", target_id=str(test_store_id),
            )
            db.session.commit()
            assert row.user_id == 42
            assert "cashier@test.com" in row.user_name
            assert "Platform Admin" in row.user_name
            assert "superadmin" in row.user_name.lower()

    def test_plain_operator_audit_is_unchanged(self, test_store_id):
        from api.Core.Audit import audit_operator
        claims = {
            "sub": "42", "username": "cashier@test.com", "role": "admin",
            "store_id": test_store_id,
        }
        with db_session():
            row = audit_operator(
                db.session, claims, action="update_settings",
                target_type="store", target_id=str(test_store_id),
            )
            db.session.commit()
            assert row.user_name == "cashier@test.com"


class TestStop:
    def test_stop_audits_and_drops_the_cookie(
        self, client, sa_headers, test_store_id,
    ):
        uid = _mk_user(test_store_id)
        token = _impersonate(client, sa_headers, uid).json()["token"]
        resp = client.post(
            "/api/v2/superadmin/impersonate/stop",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["ok"] is True
        cookie = resp.headers.get("set-cookie", "")
        assert "db_access_token=" in cookie
        assert "Max-Age=0" in cookie or "expires=" in cookie.lower()
        from api.Modules.Audit.Models import SuperadminAuditLog
        with db_session():
            rows = (
                db.session.query(SuperadminAuditLog)
                .filter_by(action="impersonation_ended", target_id=str(uid))
                .all()
            )
            assert len(rows) == 1
            assert rows[0].admin_id == _superadmin_id()

    def test_stop_without_an_impersonation_token_is_refused(
        self, client, sa_headers,
    ):
        resp = client.post(
            "/api/v2/superadmin/impersonate/stop", headers=sa_headers,
        )
        assert resp.status_code == 400

    def test_stop_is_not_a_superadmin_only_route_for_the_customer_token(
        self, client, test_store_id,
    ):
        """A customer's own session (no impersonation claim) gets the
        same 400, never a 401/403 that would hint at the route."""
        from tests.conftest import login_employee
        uid = _mk_user(test_store_id, role="employee")
        from api.Modules.Tenancy.Models import User
        with db_session():
            username = db.session.get(User, uid).username
        token = login_employee(
            client, test_store_id, username, password="targetpass123!",
        )
        resp = client.post(
            "/api/v2/superadmin/impersonate/stop",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 400


@pytest.mark.usefixtures("client")
class TestImpersonatedWritesCarryTheTrace:
    def test_a_write_as_the_customer_records_the_superadmin(
        self, client, sa_headers, test_store_id,
    ):
        """End to end: a superadmin impersonates a store admin and
        updates the store's settings; the store's operator audit
        log shows the admin AND the superadmin behind them."""
        uid = _mk_user(test_store_id)
        token = _impersonate(client, sa_headers, uid).json()["token"]
        # The route under test is the support-ticket update; create
        # a ticket as the impersonated admin first.
        created = client.post(
            "/api/v2/tickets",
            headers={"Authorization": f"Bearer {token}"},
            json={"subject": "Impersonated ticket", "body": "hello",
                  "category": "question"},
        )
        assert created.status_code == 201, created.text
        tid = created.json()["ticket"]["id"]
        resp = client.put(
            f"/api/v2/tickets/{tid}",
            headers={"Authorization": f"Bearer {token}"},
            json={"status": "resolved"},
        )
        assert resp.status_code == 200, resp.text
        from api.Modules.Audit.Models import OperatorAuditLog
        with db_session():
            row = (
                db.session.query(OperatorAuditLog)
                .filter_by(action="update_support_ticket", target_id=str(tid))
                .order_by(OperatorAuditLog.id.desc())
                .first()
            )
            assert row is not None
            assert row.user_id == uid
            assert "superadmin" in row.user_name.lower()


def test_login_superadmin_helper_still_works(client):
    # Guard: the helper used above keeps returning a bearer token.
    assert login_superadmin(client)
