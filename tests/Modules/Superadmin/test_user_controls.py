"""Superadmin login controls end the person's sessions the way the
store-admin paths already do (PR #925): a password reset, a role
change or a disable leaves no live refresh row behind, so the old
device is signed out on its next call instead of keeping access.
The role change also keeps the owner umbrella consistent.
"""
from datetime import datetime

import pytest

from tests._app import db, db_session
from tests.conftest import login_superadmin


@pytest.fixture
def sa_token(client):
    return login_superadmin(client)


@pytest.fixture
def sa_headers(sa_token):
    return {"Authorization": f"Bearer {sa_token}"}


def _mk_user(store_id, *, role="admin", password="pw12345678"):
    from api.Modules.Tenancy.Models import User
    stamp = datetime.utcnow().timestamp()
    with db_session():
        u = User(
            store_id=store_id, role=role, is_active=True,
            username=f"ctl-{role}-{store_id}-{stamp}@test.com",
        )
        u.set_password(password)
        db.session.add(u)
        db.session.commit()
        return u.id, u.username


def _login(client, username, store_id, password="pw12345678"):
    r = client.post("/api/v2/auth/login", json={
        "username": username, "password": password, "store_id": store_id,
    })
    assert r.status_code == 200, r.text
    return r.get_json()["access_token"]


def _live_refresh_rows(user_id):
    from api.Modules.Auth.Models import RefreshToken
    with db_session():
        return (
            db.session.query(RefreshToken)
            .filter(RefreshToken.user_id == user_id,
                    RefreshToken.revoked_at.is_(None))
            .count()
        )


class TestSessionsEnd:
    def test_force_password_reset_signs_the_person_out(
        self, client, sa_headers, test_store_id,
    ):
        uid, username = _mk_user(test_store_id)
        _login(client, username, test_store_id)
        assert _live_refresh_rows(uid) == 1
        resp = client.post(
            f"/api/v2/superadmin/users/{uid}/force-password-reset",
            headers=sa_headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["temp_password"]
        assert _live_refresh_rows(uid) == 0

    def test_disable_signs_the_person_out(
        self, client, sa_headers, test_store_id,
    ):
        uid, username = _mk_user(test_store_id)
        _login(client, username, test_store_id)
        resp = client.post(
            f"/api/v2/superadmin/users/{uid}/toggle-active",
            headers=sa_headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["is_active"] is False
        assert _live_refresh_rows(uid) == 0

    def test_role_change_signs_the_person_out(
        self, client, sa_headers, test_store_id,
    ):
        uid, username = _mk_user(test_store_id, role="employee")
        _login(client, username, test_store_id)
        resp = client.post(
            f"/api/v2/superadmin/users/{uid}/change-role",
            headers=sa_headers, json={"role": "admin"},
        )
        assert resp.status_code == 200, resp.text
        assert _live_refresh_rows(uid) == 0


class TestChangeRole:
    def test_body_is_typed(self, client, sa_headers, test_store_id):
        uid, _ = _mk_user(test_store_id)
        resp = client.post(
            f"/api/v2/superadmin/users/{uid}/change-role",
            headers=sa_headers, json={"role": "boss"},
        )
        assert resp.status_code == 422
        resp = client.post(
            f"/api/v2/superadmin/users/{uid}/change-role",
            headers=sa_headers, json={},
        )
        assert resp.status_code == 422

    def test_promoting_to_owner_links_the_home_store(
        self, client, sa_headers, test_store_id,
    ):
        uid, _ = _mk_user(test_store_id)
        resp = client.post(
            f"/api/v2/superadmin/users/{uid}/change-role",
            headers=sa_headers, json={"role": "owner"},
        )
        assert resp.status_code == 200, resp.text
        from api.Modules.Tenancy.Models import StoreOwnerLink, User
        with db_session():
            assert db.session.get(User, uid).role == "owner"
            links = (
                db.session.query(StoreOwnerLink)
                .filter_by(owner_id=uid, store_id=test_store_id)
                .count()
            )
            assert links == 1
        # Idempotent on a second promote (no duplicate link row).
        client.post(
            f"/api/v2/superadmin/users/{uid}/change-role",
            headers=sa_headers, json={"role": "admin"},
        )
        resp = client.post(
            f"/api/v2/superadmin/users/{uid}/change-role",
            headers=sa_headers, json={"role": "owner"},
        )
        assert resp.status_code == 200, resp.text
        with db_session():
            assert (
                db.session.query(StoreOwnerLink)
                .filter_by(owner_id=uid, store_id=test_store_id)
                .count()
            ) == 1
