"""An access token is refused the moment the person it names is no
longer who it says, or their session was signed out.

Before this (audit of 2026-10-08) ``get_principal`` was DB-free: a
demoted admin kept admin access, a deactivated login kept working,
and every "revoke sessions" button only bit at the next refresh —
up to 30 minutes later. ``_require_live_principal`` in the Auth
controller closes that; these tests pin it from the outside.
"""
from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _mk_user(store_id, username, role="admin", password="pw12345678"):
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, role=role,
                 is_active=True)
        u.set_password(password)
        db.session.add(u)
        db.session.commit()
        return u.id


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


def test_deactivated_login_is_refused_at_once(client, test_store_id):
    uid = _mk_user(test_store_id, "deact.live@test.com")
    victim = _login(client, "deact.live@test.com", test_store_id)
    assert client.get("/api/v2/admin/users", headers=_h(victim)).status_code == 200

    admin = login_admin(client, test_store_id)
    r = client.patch(
        f"/api/v2/admin/users/{uid}", headers=_h(admin),
        json={"is_active": False},
    )
    assert r.status_code == 200, r.text
    assert client.get("/api/v2/admin/users", headers=_h(victim)).status_code == 401
    assert _live_refresh_rows(uid) == 0


def test_demoted_admin_loses_admin_access_at_once(client, test_store_id):
    uid = _mk_user(test_store_id, "demote.live@test.com")
    victim = _login(client, "demote.live@test.com", test_store_id)
    admin = login_admin(client, test_store_id)
    r = client.patch(
        f"/api/v2/admin/users/{uid}", headers=_h(admin),
        json={"role": "employee"},
    )
    assert r.status_code == 200, r.text
    # The old token says "admin"; the row says "employee". Refused,
    # not merely re-scoped — a fresh login carries the new role.
    assert client.get("/api/v2/admin/users", headers=_h(victim)).status_code == 401
    assert _live_refresh_rows(uid) == 0
    fresh = _login(client, "demote.live@test.com", test_store_id)
    assert client.get("/api/v2/admin/users", headers=_h(fresh)).status_code == 403


def test_password_reset_by_admin_signs_the_person_out(client, test_store_id):
    uid = _mk_user(test_store_id, "pwreset.live@test.com")
    victim = _login(client, "pwreset.live@test.com", test_store_id)
    admin = login_admin(client, test_store_id)
    r = client.patch(
        f"/api/v2/admin/users/{uid}", headers=_h(admin),
        json={"password": "brand-new-pass"},
    )
    assert r.status_code == 200, r.text
    assert client.get("/api/v2/admin/users", headers=_h(victim)).status_code == 401
    assert _live_refresh_rows(uid) == 0


def test_name_change_keeps_the_session(client, test_store_id):
    uid = _mk_user(test_store_id, "rename.live@test.com")
    victim = _login(client, "rename.live@test.com", test_store_id)
    admin = login_admin(client, test_store_id)
    r = client.patch(
        f"/api/v2/admin/users/{uid}", headers=_h(admin),
        json={"full_name": "Still Signed In"},
    )
    assert r.status_code == 200, r.text
    assert client.get("/api/v2/admin/users", headers=_h(victim)).status_code == 200
    assert _live_refresh_rows(uid) == 1


def test_superadmin_revoke_sessions_bounces_on_the_next_call(
    client, test_store_id,
):
    uid = _mk_user(test_store_id, "sa.revoke@test.com")
    victim = _login(client, "sa.revoke@test.com", test_store_id)
    sa = login_superadmin(client)
    r = client.post(
        f"/api/v2/superadmin/users/{uid}/revoke-sessions", headers=_h(sa),
    )
    assert r.status_code == 200, r.text
    assert client.get("/api/v2/admin/users", headers=_h(victim)).status_code == 401


def test_revoking_other_sessions_kills_their_access_tokens(
    client, test_store_id,
):
    _mk_user(test_store_id, "two.devices@test.com")
    phone = _login(client, "two.devices@test.com", test_store_id)
    laptop = _login(client, "two.devices@test.com", test_store_id)
    r = client.delete("/api/v2/auth/sessions/others", headers=_h(laptop))
    assert r.status_code == 200, r.text
    assert client.get("/api/v2/admin/users", headers=_h(phone)).status_code == 401
    assert client.get("/api/v2/admin/users", headers=_h(laptop)).status_code == 200


def test_owner_switch_store_token_stays_valid(client, test_store_id):
    """The one sanctioned role mismatch: an owner's switch-store
    token says role=admin while the row says owner."""
    _mk_user(None, "owner.live@test.com", role="owner")
    base = _login(client, "owner.live@test.com", None)
    from api.Modules.Tenancy.Models import StoreOwnerLink, User
    with db_session():
        owner = db.session.query(User).filter_by(username="owner.live@test.com").one()
        db.session.add(StoreOwnerLink(owner_id=owner.id, store_id=test_store_id))
        db.session.commit()
    switched = client.post(
        "/api/v2/auth/switch-store", headers=_h(base),
        json={"store_id": test_store_id},
    )
    assert switched.status_code == 200, switched.text
    tok = switched.get_json()["access_token"]
    assert client.get("/api/v2/admin/users", headers=_h(tok)).status_code == 200
