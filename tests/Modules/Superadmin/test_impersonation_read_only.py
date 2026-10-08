"""Read-only impersonation: look at a customer's books without
being able to change them.

The mode rides in the token (``impersonation_mode``), and
``get_principal`` refuses every non-GET call on such a token — a
403 with ``reason: read_only_impersonation`` so the SPA can say
why — except the one that ends the impersonation.
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


def _mk_user(store_id):
    from api.Modules.Tenancy.Models import User
    stamp = datetime.utcnow().timestamp()
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
