"""Read-only impersonation: look at a customer's books without
being able to change them.

The mode rides in the token (``impersonation_mode``), and
``get_principal`` refuses every non-GET call on such a token — a
403 with ``reason: read_only_impersonation`` so the SPA can say
why — except the one that ends the impersonation.
"""

import jwt
import pytest

from tests._app import db, db_session
from tests.conftest import login_superadmin
from api.Core.Clock import utc_now


@pytest.fixture
def sa_token(client):
    return login_superadmin(client)


@pytest.fixture
def sa_headers(sa_token):
    return {"Authorization": f"Bearer {sa_token}"}


def _mk_user(store_id):
    from api.Modules.Tenancy.Models import User
    stamp = utc_now().timestamp()
    with db_session():
        u = User(username=f"ro-{store_id}-{stamp}@test.com", role="admin",
                 full_name="RO Target", store_id=store_id, is_active=True)
        u.set_password("targetpass123!")
        db.session.add(u)
        db.session.commit()
        return u.id


def _start(client, sa_headers, uid, mode):
    resp = client.post(
        f"/api/v2/superadmin/impersonate/{uid}", headers=sa_headers,
        json={"mode": mode},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


class TestReadOnly:
    def test_token_and_session_status_say_read_only(
        self, client, sa_headers, test_store_id,
    ):
        token = _start(client, sa_headers, _mk_user(test_store_id), "read_only")
        claims = jwt.decode(token, options={"verify_signature": False})
        assert claims["impersonation_mode"] == "read_only"
        status = client.get(
            "/api/v2/auth/session-status",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert status.status_code == 200
        assert status.json()["impersonation"]["read_only"] is True

    def test_full_mode_is_the_default_and_says_so(
        self, client, sa_headers, test_store_id,
    ):
        uid = _mk_user(test_store_id)
        resp = client.post(
            f"/api/v2/superadmin/impersonate/{uid}", headers=sa_headers,
        )
        assert resp.status_code == 200, resp.text
        token = resp.json()["token"]
        claims = jwt.decode(token, options={"verify_signature": False})
        assert claims.get("impersonation_mode", "full") == "full"
        status = client.get(
            "/api/v2/auth/session-status",
            headers={"Authorization": f"Bearer {token}"},
        ).json()
        assert status["impersonation"]["read_only"] is False

    def test_reads_work_and_writes_are_refused(
        self, client, sa_headers, test_store_id,
    ):
        token = _start(client, sa_headers, _mk_user(test_store_id), "read_only")
        h = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/v2/tickets", headers=h).status_code == 200
        resp = client.post(
            "/api/v2/tickets", headers=h,
            json={"subject": "nope", "body": "nope", "category": "question"},
        )
        assert resp.status_code == 403, resp.text
        body = resp.json()
        assert body["reason"] == "read_only_impersonation"
        assert "read-only" in body["detail"].lower()
        from api.Modules.Support.Models import SupportTicket
        with db_session():
            assert (
                db.session.query(SupportTicket).filter_by(subject="nope").count()
            ) == 0

    def test_put_patch_delete_are_refused_too(
        self, client, sa_headers, test_store_id,
    ):
        token = _start(client, sa_headers, _mk_user(test_store_id), "read_only")
        h = {"Authorization": f"Bearer {token}"}
        for method in ("put", "patch", "delete"):
            resp = getattr(client, method)("/api/v2/tickets/1", headers=h, json={})
            assert resp.status_code == 403, (method, resp.status_code)

    def test_stop_still_works(self, client, sa_headers, test_store_id):
        token = _start(client, sa_headers, _mk_user(test_store_id), "read_only")
        resp = client.post(
            "/api/v2/superadmin/impersonate/stop",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text

    def test_auth_writes_on_the_customers_account_are_refused(
        self, client, sa_headers, test_store_id,
    ):
        """``/auth/*`` used to be exempt wholesale, so a read-only
        viewer could change the customer's e-mail (their login),
        password, sessions or passkeys."""
        from api.Modules.Tenancy.Models import User
        uid = _mk_user(test_store_id)
        token = _start(client, sa_headers, uid, "read_only")
        h = {"Authorization": f"Bearer {token}"}
        for method, path, body in (
            ("put", "/api/v2/auth/profile", {"email": "attacker@x.com"}),
            ("put", "/api/v2/auth/notifications", {}),
            ("post", "/api/v2/auth/change-password", {
                "current_password": "targetpass123!",
                "new_password": "pwned-pass-123",
                "confirm_password": "pwned-pass-123",
            }),
            ("post", "/api/v2/auth/passkeys/register/begin", {}),
            ("delete", "/api/v2/auth/sessions/others", None),
            ("post", "/api/v2/auth/my-stores", {"name": "RO store"}),
        ):
            kw = {"headers": h}
            if body is not None:
                kw["json"] = body
            resp = getattr(client, method)(path, **kw)
            assert resp.status_code == 403, (path, resp.status_code)
            assert resp.json()["reason"] == "read_only_impersonation"
        with db_session():
            u = db.session.get(User, uid)
            assert u.email != "attacker@x.com"
            assert u.check_password("targetpass123!")

    def test_session_plumbing_still_works(
        self, client, sa_headers, test_store_id,
    ):
        """Refresh and logout carry no customer data: never 403."""
        token = _start(client, sa_headers, _mk_user(test_store_id), "read_only")
        h = {"Authorization": f"Bearer {token}"}
        resp = client.post("/api/v2/auth/refresh", headers=h)
        assert resp.status_code != 403
        resp = client.post("/api/v2/auth/logout", headers=h)
        assert resp.status_code == 204
        # A stale read-only cookie never locks the browser out of
        # signing in (opaque 401 for bad creds, not the 403 gate).
        resp = client.post(
            "/api/v2/auth/login-cross-store", headers=h,
            json={"username": "nobody@x.com", "password": "nope-nope"},
        )
        assert resp.status_code != 403

    def test_full_mode_still_writes_under_auth(
        self, client, sa_headers, test_store_id,
    ):
        token = _start(client, sa_headers, _mk_user(test_store_id), "full")
        resp = client.put(
            "/api/v2/auth/profile",
            headers={"Authorization": f"Bearer {token}"},
            json={"full_name": "Changed by support"},
        )
        assert resp.status_code == 200, resp.text

    def test_unknown_mode_is_422(self, client, sa_headers, test_store_id):
        uid = _mk_user(test_store_id)
        resp = client.post(
            f"/api/v2/superadmin/impersonate/{uid}", headers=sa_headers,
            json={"mode": "god"},
        )
        assert resp.status_code == 422

    def test_audit_row_names_the_mode(self, client, sa_headers, test_store_id):
        uid = _mk_user(test_store_id)
        _start(client, sa_headers, uid, "read_only")
        from api.Modules.Audit.Models import SuperadminAuditLog
        with db_session():
            row = (
                db.session.query(SuperadminAuditLog)
                .filter_by(action="impersonate_user", target_id=str(uid))
                .order_by(SuperadminAuditLog.id.desc()).first()
            )
            assert row is not None
            assert "read-only" in row.details


# ── An impersonated owner entering a store stays impersonated ──
#
# /auth/switch-store minted a plain owner-context admin token from
# an impersonation token: no impersonated_by, no read-only mode,
# a fresh expiry — a read-only look became a full, unattributed
# admin session at the owner's store.


def _mk_owner(store_id):
    from api.Modules.Tenancy.Models import StoreOwnerLink, User
    stamp = utc_now().timestamp()
    with db_session():
        o = User(username=f"own-ro-{stamp}@test.com", role="owner",
                 full_name="Owner RO", store_id=None, is_active=True)
        o.set_password("ownerpass123")
        db.session.add(o)
        db.session.flush()
        db.session.add(StoreOwnerLink(owner_id=o.id, store_id=store_id))
        db.session.commit()
        return o.id


def _switch(client, token, store_id):
    resp = client.post(
        "/api/v2/auth/switch-store",
        headers={"Authorization": f"Bearer {token}"},
        json={"store_id": store_id},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestImpersonatedOwnerSwitch:
    def test_read_only_survives_switch_store(
        self, client, sa_headers, test_store_id,
    ):
        token = _start(client, sa_headers, _mk_owner(test_store_id), "read_only")
        before = jwt.decode(token, options={"verify_signature": False})
        body = _switch(client, token, test_store_id)
        claims = jwt.decode(
            body["access_token"], options={"verify_signature": False},
        )
        assert claims["role"] == "admin" and claims["owner_id"]
        assert claims["impersonation_mode"] == "read_only"
        assert claims["impersonated_by"] == before["impersonated_by"]
        assert claims["impersonator_name"] == before["impersonator_name"]
        assert claims["exp"] <= before["exp"]
        assert body["expires_in"] <= before["exp"] - before["iat"]

        nh = {"Authorization": f"Bearer {body['access_token']}"}
        resp = client.put(
            "/api/v2/admin/store-info", headers=nh, json={"name": "PWNED"},
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["reason"] == "read_only_impersonation"
        status = client.get("/api/v2/auth/session-status", headers=nh).json()
        assert status["impersonation"]["read_only"] is True
        # Stop still works from the derived token.
        resp = client.post("/api/v2/superadmin/impersonate/stop", headers=nh)
        assert resp.status_code == 200, resp.text

    def test_full_impersonation_switch_keeps_attribution(
        self, client, sa_headers, test_store_id,
    ):
        token = _start(client, sa_headers, _mk_owner(test_store_id), "full")
        body = _switch(client, token, test_store_id)
        claims = jwt.decode(
            body["access_token"], options={"verify_signature": False},
        )
        assert claims["impersonated_by"]
        assert "impersonation_mode" not in claims
        nh = {"Authorization": f"Bearer {body['access_token']}"}
        status = client.get("/api/v2/auth/session-status", headers=nh).json()
        assert status["impersonation"]["read_only"] is False

    def test_plain_owner_switch_is_unchanged(self, client, test_store_id):
        from api.Modules.Auth.Services.jwt_issuer import (
            DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
        )
        from api.Modules.Tenancy.Models import User
        oid = _mk_owner(test_store_id)
        with db_session():
            username = db.session.get(User, oid).username
        login = client.post("/api/v2/auth/login-cross-store", json={
            "username": username, "password": "ownerpass123",
        })
        assert login.status_code == 200, login.text
        body = _switch(client, login.json()["access_token"], test_store_id)
        claims = jwt.decode(
            body["access_token"], options={"verify_signature": False},
        )
        assert "impersonated_by" not in claims
        assert "impersonation_mode" not in claims
        assert body["expires_in"] == DEFAULT_ACCESS_TOKEN_TTL_SECONDS
