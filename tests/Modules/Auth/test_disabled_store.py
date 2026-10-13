"""Superadmin "Disable store" actually blocks the store.

``Store.is_active`` used to be read only by the public slug lookup:
a disabled store's admins and employees kept signing in and saving.
The rule now (Auth INVARIANTS "Disabled stores"):

* password login for the store's staff is refused with a clear
  403 — but only once the password checked out;
* live tokens scoped to the store 401 on the next call, and
  ``/auth/refresh`` refuses;
* owners still sign in; ``/auth/switch-store`` into the disabled
  store is a 403, into an active one still works;
* the superadmin and superadmin impersonation are unaffected;
* re-enabling restores access with no other step;
* a NULL ``is_active`` (nullable column, no server default) is active.
"""
import pytest

from tests._app import db, db_session
from tests.conftest import login_superadmin

MSG = "This store has been disabled. Contact support."
PW = "pw12345678"


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _mk_store(slug):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = Store(name=f"Store {slug}", slug=slug, email=f"{slug}@x.com",
                  plan="basic")
        db.session.add(s)
        db.session.commit()
        return s.id


def _mk_user(store_id, username, role="admin", password=PW):
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, role=role,
                 full_name=username, email=username, is_active=True)
        u.set_password(password)
        db.session.add(u)
        db.session.commit()
        return u.id


def _set_active(store_id, value):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        db.session.get(Store, store_id).is_active = value
        db.session.commit()


def _login(client, username, store_id, password=PW):
    return client.post("/api/v2/auth/login", json={
        "username": username, "password": password, "store_id": store_id,
    })


def _cross(client, username, password=PW):
    return client.post("/api/v2/auth/login-cross-store", json={
        "username": username, "password": password,
    })


def _toggle(client, store_id):
    sa = login_superadmin(client)
    r = client.post(
        f"/api/v2/superadmin/stores/{store_id}/toggle-active",
        headers=_h(sa),
    )
    assert r.status_code == 200, r.text
    return r.json()["is_active"]


# ── Login ───────────────────────────────────────────────────


@pytest.mark.parametrize("role", ["admin", "employee"])
def test_staff_refused_after_disable_and_accepted_after_enable(client, role):
    sid = _mk_store(f"dis-{role}")
    name = f"dis.{role}@test.com"
    _mk_user(sid, name, role=role)
    assert _login(client, name, sid).status_code == 200

    assert _toggle(client, sid) is False
    r = _login(client, name, sid)
    assert r.status_code == 403
    assert r.json()["detail"] == MSG
    r = _cross(client, name)
    assert r.status_code == 403
    assert r.json()["detail"] == MSG

    assert _toggle(client, sid) is True
    assert _login(client, name, sid).status_code == 200
    assert _cross(client, name).status_code == 200


def test_wrong_password_at_disabled_store_stays_opaque(client):
    """The store's state is revealed only after the password checks out."""
    sid = _mk_store("dis-opaque")
    _mk_user(sid, "dis.opaque@test.com")
    _set_active(sid, False)
    for r in (_login(client, "dis.opaque@test.com", sid, "nope-nope-1"),
              _cross(client, "dis.opaque@test.com", "nope-nope-1")):
        assert r.status_code == 401
        assert r.json()["detail"] == "Invalid username or password"


def test_same_credentials_at_a_disabled_and_an_active_store(client):
    """A disabled store's account drops out of the cross-store
    choice instead of making the person pick it and fail."""
    off = _mk_store("dis-twin-off")
    on = _mk_store("dis-twin-on")
    _mk_user(off, "twin@test.com")
    _mk_user(on, "twin@test.com")
    _set_active(off, False)
    r = _cross(client, "twin@test.com")
    assert r.status_code == 200, r.text
    assert r.json()["store_id"] == on


def test_null_is_active_counts_as_active(client):
    sid = _mk_store("dis-null")
    _mk_user(sid, "dis.null@test.com")
    _set_active(sid, None)
    r = _login(client, "dis.null@test.com", sid)
    assert r.status_code == 200, r.text
    assert client.get(
        "/api/v2/admin/users", headers=_h(r.json()["access_token"]),
    ).status_code == 200
    # The first toggle of a NULL row disables it.
    assert _toggle(client, sid) is False


# ── Live sessions + refresh ─────────────────────────────────


def test_existing_token_refused_after_disable_restored_after_enable(client):
    sid = _mk_store("dis-live")
    _mk_user(sid, "dis.live@test.com")
    tok = _login(client, "dis.live@test.com", sid).json()["access_token"]
    assert client.get("/api/v2/admin/users", headers=_h(tok)).status_code == 200

    _toggle(client, sid)
    r = client.get("/api/v2/admin/users", headers=_h(tok))
    assert r.status_code == 401
    assert r.json()["detail"] == MSG

    _toggle(client, sid)
    assert client.get("/api/v2/admin/users", headers=_h(tok)).status_code == 200


def test_refresh_refused_after_disable_and_works_after_enable(client):
    from tests.conftest import _starlette_client
    sid = _mk_store("dis-refresh")
    _mk_user(sid, "dis.refresh@test.com")
    assert _login(client, "dis.refresh@test.com", sid).status_code == 200
    jti = _starlette_client.cookies.get("db_refresh_token")
    assert client.post("/api/v2/auth/refresh").status_code == 200

    _set_active(sid, False)
    r = client.post("/api/v2/auth/refresh")
    assert r.status_code == 401
    assert r.json()["detail"] == MSG

    # The chain was not revoked: re-enabling is the only step.
    _set_active(sid, True)
    _starlette_client.cookies.set(
        "db_refresh_token", jti, path="/api/v2/auth",
    )
    assert client.post("/api/v2/auth/refresh").status_code == 200


def test_bulk_disable_blocks_and_bulk_enable_restores(client):
    a = _mk_store("dis-bulk-a")
    b = _mk_store("dis-bulk-b")
    _mk_user(a, "bulk.a@test.com")
    _mk_user(b, "bulk.b@test.com", role="employee")
    tok_a = _login(client, "bulk.a@test.com", a).json()["access_token"]

    sa = login_superadmin(client)
    r = client.post("/api/v2/superadmin/bulk-action", headers=_h(sa),
                    json={"store_ids": [a, b], "action": "disable"})
    assert r.status_code == 200, r.text
    assert client.get("/api/v2/admin/users", headers=_h(tok_a)).status_code == 401
    assert _login(client, "bulk.a@test.com", a).status_code == 403
    assert _login(client, "bulk.b@test.com", b).status_code == 403

    r = client.post("/api/v2/superadmin/bulk-action", headers=_h(sa),
                    json={"store_ids": [a, b], "action": "enable"})
    assert r.status_code == 200, r.text
    assert _login(client, "bulk.a@test.com", a).status_code == 200
    assert _login(client, "bulk.b@test.com", b).status_code == 200


# ── Owners ──────────────────────────────────────────────────


def _mk_owner_with_stores():
    from api.Modules.Tenancy.Models import StoreOwnerLink
    home = _mk_store("dis-own-home")
    other = _mk_store("dis-own-other")
    oid = _mk_user(home, "dis.owner@test.com", role="owner")
    with db_session():
        db.session.add(StoreOwnerLink(owner_id=oid, store_id=other))
        db.session.commit()
    return oid, home, other


def _switch(client, tok, store_id):
    return client.post("/api/v2/auth/switch-store", headers=_h(tok),
                       json={"store_id": store_id})


def test_owner_signs_in_but_cannot_switch_into_disabled_store(client):
    _oid, home, other = _mk_owner_with_stores()
    _set_active(home, False)

    r = _cross(client, "dis.owner@test.com")
    assert r.status_code == 200, r.text
    tok = r.json()["access_token"]
    # The umbrella view keeps working on the base owner token.
    assert client.get("/api/v2/auth/my-stores", headers=_h(tok)).status_code == 200

    r = _switch(client, tok, home)
    assert r.status_code == 403
    assert r.json()["detail"] == MSG
    r = _switch(client, tok, other)
    assert r.status_code == 200, r.text

    _set_active(home, True)
    assert _switch(client, tok, home).status_code == 200


def test_owner_store_token_ends_when_that_store_is_disabled(client):
    _oid, _home, other = _mk_owner_with_stores()
    tok = _cross(client, "dis.owner@test.com").json()["access_token"]
    store_tok = _switch(client, tok, other).json()["access_token"]
    h = _h(store_tok)
    assert client.get("/api/v2/dayclose/departments", headers=h).status_code == 200

    _set_active(other, False)
    assert client.get("/api/v2/dayclose/departments", headers=h).status_code == 401
    # The owner's base token is untouched.
    assert client.get("/api/v2/auth/my-stores", headers=_h(tok)).status_code == 200


# ── Superadmin + impersonation ──────────────────────────────


def test_superadmin_unaffected_and_impersonation_still_works(client):
    sid = _mk_store("dis-imp")
    uid = _mk_user(sid, "dis.imp@test.com")
    _set_active(sid, False)

    sa = login_superadmin(client)
    assert client.get("/api/v2/superadmin/stores", headers=_h(sa)).status_code == 200
    r = client.post(f"/api/v2/superadmin/impersonate/{uid}", headers=_h(sa))
    assert r.status_code == 200, r.text
    imp = r.json()["token"]
    assert client.get("/api/v2/admin/users", headers=_h(imp)).status_code == 200
