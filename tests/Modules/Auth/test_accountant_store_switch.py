"""The in-app store switch for accountants (linked logins).

An accountant has one login per store. Signing in with the store
picker links every other ACCOUNTANT login that the same identifier
and password open (a refresh row in the same browser session), and
``/auth/my-stores`` + ``/auth/switch-store`` move the session between
them. See ``api/Modules/Auth/Services/linked_logins.py`` and Auth
INVARIANTS.md, "Linked accountant logins".

Pinned here: grant (switch there and back, refresh keeps the store,
audit row), deny (different password, another role, someone else's
store, no session, other roles), revoke (deactivated, role changed,
store disabled, the store's admin signs them out) and sign-out
(logout and Devices end every linked store together).
"""
from __future__ import annotations

from tests._app import db, db_session

ACC = "cpa@linked.example"
PW = "ledger-pass-1!"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _store(slug: str, name: str) -> int:
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = Store(name=name, slug=slug, email=f"{slug}@x.com", plan="basic",
                  address=f"{name} Rd")
        db.session.add(s)
        db.session.commit()
        return s.id


def _user(store_id: int, role: str = "accountant", pw: str = PW,
          username: str = ACC) -> int:
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, email=username,
                 full_name="Pat Ledger", role=role, is_active=True)
        u.set_password(pw)
        db.session.add(u)
        db.session.commit()
        return u.id


def _sign_in(client, store_id: int, pw: str = PW) -> dict:
    """The store picker's second step: the chosen store + password."""
    resp = client.post("/api/v2/auth/login", json={
        "username": ACC, "password": pw, "store_id": store_id,
    })
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()


def _my_stores(client, token: str) -> dict[int, dict]:
    resp = client.get("/api/v2/auth/my-stores", headers=_auth(token))
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return {s["store_id"]: s for s in resp.get_json()["stores"]}


def _switch(client, token: str, store_id: int):
    return client.post("/api/v2/auth/switch-store", headers=_auth(token),
                       json={"store_id": store_id})


def _two_stores():
    a = _store("lnk-a", "Alpha Books")
    b = _store("lnk-b", "Beta Books")
    ua = _user(a)
    ub = _user(b)
    return a, b, ua, ub


def _report(client, token: str, store_id: int) -> int:
    return client.get(
        f"/api/v2/reports/sales-by-company?store_ids={store_id}",
        headers=_auth(token),
    ).status_code


# ── grant ───────────────────────────────────────────────────


def test_accountant_switches_store_and_back_without_signing_in(client):
    a, b, ua, ub = _two_stores()
    signed_in = _sign_in(client, a)
    token = signed_in["access_token"]

    stores = _my_stores(client, token)
    assert set(stores) == {a, b}
    assert stores[a]["is_current"] is True
    assert stores[b]["is_current"] is False
    assert stores[b]["name"] == "Beta Books"

    resp = _switch(client, token, b)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json()
    # The token is the accountant's OWN store-B login: its user row,
    # its role, no owner context.
    assert body["user_id"] == ub
    assert body["store_id"] == b
    assert body["store_name"] == "Beta Books"
    assert body["role"] == "accountant"
    assert body["owner_id"] is None
    assert body["refresh_jti"]
    assert "reports.read" in body["permissions"]
    token_b = body["access_token"]

    assert _report(client, token_b, b) == 200
    # Store-B token never reaches store A, and the old one never B.
    assert _report(client, token_b, a) == 403
    assert _report(client, token, b) == 403
    # Still view only at store B.
    assert client.put(
        "/api/v2/monthly/2026/1", headers=_auth(token_b), json={},
    ).status_code == 403

    stores = _my_stores(client, token_b)
    assert stores[b]["is_current"] is True

    back = _switch(client, token_b, a)
    assert back.status_code == 200
    assert back.get_json()["user_id"] == ua


def test_silent_refresh_keeps_the_chosen_store(client):
    a, b, _, ub = _two_stores()
    token = _sign_in(client, a)["access_token"]
    switched = _switch(client, token, b).get_json()
    # The switch moved the refresh cookie onto the store-B login.
    resp = client.post("/api/v2/auth/refresh")
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json()
    assert body["user_id"] == ub
    assert body["store_id"] == b
    assert body["refresh_jti"] == switched["refresh_jti"]


def test_each_switch_is_audited_at_the_store_entered(client):
    from api.Modules.Audit.Models import OperatorAuditLog
    a, b, _, ub = _two_stores()
    token = _sign_in(client, a)["access_token"]
    assert _switch(client, token, b).status_code == 200
    with db_session():
        rows = (
            db.session.query(OperatorAuditLog)
              .filter_by(store_id=b, action="accountant_switch_store")
              .all()
        )
        assert len(rows) == 1
        assert rows[0].user_id == ub
        assert rows[0].target_id == str(b)


def test_cookie_only_session_switches_too(client):
    """The SPA sends no bearer header: the httpOnly cookie is the
    whole credential, and the switch replaces it."""
    a, b, _, ub = _two_stores()
    _sign_in(client, a)
    stores = client.get("/api/v2/auth/my-stores").get_json()["stores"]
    assert {s["store_id"] for s in stores} == {a, b}
    assert client.post("/api/v2/auth/switch-store",
                       json={"store_id": b}).status_code == 200
    me = client.get("/api/v2/auth/me").get_json()
    assert me["user_id"] == ub
    assert me["store_id"] == b


# ── deny ────────────────────────────────────────────────────


def test_one_store_accountant_has_nothing_to_switch_to(client):
    a = _store("lnk-solo", "Solo Books")
    other = _store("lnk-other", "Other Books")
    _user(a)
    token = _sign_in(client, a)["access_token"]
    assert set(_my_stores(client, token)) == {a}
    assert _switch(client, token, other).status_code == 404


def test_a_login_with_another_password_is_not_linked(client):
    """Same e-mail is not proof: a store admin can create an
    accountant login with anybody's e-mail. Only the password links."""
    a = _store("lnk-pw-a", "Alpha")
    b = _store("lnk-pw-b", "Beta")
    _user(a)
    _user(b, pw="someone-elses-pass-9")
    token = _sign_in(client, a)["access_token"]
    assert set(_my_stores(client, token)) == {a}
    assert _switch(client, token, b).status_code == 404


def test_only_accountant_logins_are_linked(client):
    """An admin or employee login with the same e-mail and password
    is never reachable from the accountant's switch."""
    a = _store("lnk-role-a", "Alpha")
    b = _store("lnk-role-b", "Beta")
    c = _store("lnk-role-c", "Gamma")
    _user(a)
    _user(b, role="admin")
    _user(c, role="employee")
    token = _sign_in(client, a)["access_token"]
    assert set(_my_stores(client, token)) == {a}
    assert _switch(client, token, b).status_code == 404
    assert _switch(client, token, c).status_code == 404


def test_signing_in_as_admin_links_nothing(client):
    """The switch is for accountants: an admin signing in with a
    password that also opens an accountant login elsewhere gets no
    linked rows, and keeps the owner-only answer."""
    from api.Modules.Auth.Models import RefreshToken
    a = _store("lnk-adm-a", "Alpha")
    b = _store("lnk-adm-b", "Beta")
    _user(a, role="admin")
    ub = _user(b)
    token = _sign_in(client, a)["access_token"]
    with db_session():
        assert db.session.query(RefreshToken).filter_by(user_id=ub).count() == 0
    assert client.get("/api/v2/auth/my-stores",
                      headers=_auth(token)).status_code == 403
    assert _switch(client, token, b).status_code == 403


def test_a_disabled_store_is_never_linked(client):
    from api.Modules.Auth.Models import RefreshToken
    from api.Modules.Tenancy.Models import Store
    a, b, _, ub = _two_stores()
    with db_session():
        db.session.get(Store, b).is_active = False
        db.session.commit()
    token = _sign_in(client, a)["access_token"]
    with db_session():
        assert db.session.query(RefreshToken).filter_by(user_id=ub).count() == 0
    assert set(_my_stores(client, token)) == {a}


def test_a_token_without_a_session_cannot_switch(client):
    """A superadmin looking at an accountant (impersonation) holds no
    browser session, so there is nothing linked to switch to."""
    from tests.conftest import login_superadmin
    a, b, ua, _ = _two_stores()
    sa = login_superadmin(client)
    resp = client.post(f"/api/v2/superadmin/impersonate/{ua}",
                       headers=_auth(sa), json={})
    assert resp.status_code == 200, resp.get_data(as_text=True)
    imp = resp.get_json()["token"]
    assert set(_my_stores(client, imp)) == set()
    assert _switch(client, imp, b).status_code == 404


def test_accountant_cannot_add_a_store(client):
    a, _, _, _ = _two_stores()
    token = _sign_in(client, a)["access_token"]
    resp = client.post("/api/v2/auth/my-stores", headers=_auth(token),
                       json={"name": "Sneaky"})
    assert resp.status_code == 403


def test_employee_still_cannot_switch(client, test_store_id):
    from tests.conftest import login_admin
    # Owner-only answer for the other store roles is unchanged.
    token = login_admin(client, test_store_id)
    assert client.get("/api/v2/auth/my-stores",
                      headers=_auth(token)).status_code == 403


# ── revoke ──────────────────────────────────────────────────


def test_switched_off_login_drops_out(client):
    from api.Modules.Tenancy.Models import User
    a, b, _, ub = _two_stores()
    token = _sign_in(client, a)["access_token"]
    with db_session():
        db.session.get(User, ub).is_active = False
        db.session.commit()
    assert set(_my_stores(client, token)) == {a}
    assert _switch(client, token, b).status_code == 404


def test_login_given_another_role_drops_out(client):
    """Even without the revoke a role change normally brings, a
    login that is no longer an accountant is never switched into."""
    from api.Modules.Tenancy.Models import User
    a, b, _, ub = _two_stores()
    token = _sign_in(client, a)["access_token"]
    with db_session():
        db.session.get(User, ub).role = "admin"
        db.session.commit()
    assert set(_my_stores(client, token)) == {a}
    assert _switch(client, token, b).status_code == 404


def test_store_disabled_after_sign_in_drops_out(client):
    from api.Modules.Tenancy.Models import Store
    a, b, _, _ = _two_stores()
    token = _sign_in(client, a)["access_token"]
    with db_session():
        db.session.get(Store, b).is_active = False
        db.session.commit()
    assert set(_my_stores(client, token)) == {a}
    assert _switch(client, token, b).status_code == 404


def test_the_stores_admin_signing_them_out_ends_only_that_store(client):
    """Store B's admin revokes the accountant's sessions: B is gone
    from the switch, store A keeps working."""
    from api.Modules.Auth.Services.principal import revoke_refresh_tokens
    a, b, _, ub = _two_stores()
    token = _sign_in(client, a)["access_token"]
    with db_session():
        revoke_refresh_tokens(db.session, user_id=ub)
        db.session.commit()
    assert set(_my_stores(client, token)) == {a}
    assert _switch(client, token, b).status_code == 404
    assert _report(client, token, a) == 200


def test_signed_out_at_the_current_store_ends_that_token(client):
    """Switched into B, then B's admin signs them out: the B token
    stops at once (live principal), like any other session."""
    from api.Modules.Auth.Services.principal import revoke_refresh_tokens
    a, b, _, ub = _two_stores()
    token = _sign_in(client, a)["access_token"]
    token_b = _switch(client, token, b).get_json()["access_token"]
    with db_session():
        revoke_refresh_tokens(db.session, user_id=ub)
        db.session.commit()
    assert _report(client, token_b, b) == 401


# ── signing out ends the whole sign-in ──────────────────────


def _live_rows(user_id: int) -> int:
    from api.Core.Clock import utc_now
    from api.Modules.Auth.Models import RefreshToken
    with db_session():
        return (
            db.session.query(RefreshToken)
              .filter(RefreshToken.user_id == user_id,
                      RefreshToken.revoked_at.is_(None),
                      RefreshToken.expires_at > utc_now())
              .count()
        )


def test_logout_signs_out_every_linked_store(client):
    a, b, ua, ub = _two_stores()
    token = _sign_in(client, a)["access_token"]
    _switch(client, token, b)
    assert _live_rows(ua) == 1 and _live_rows(ub) == 1
    assert client.post("/api/v2/auth/logout").status_code == 204
    assert _live_rows(ua) == 0
    assert _live_rows(ub) == 0
    assert _report(client, token, a) == 401


def test_signing_a_device_out_ends_it_at_every_store(client):
    a, b, ua, ub = _two_stores()
    signed_in = _sign_in(client, a)
    token = signed_in["access_token"]
    sessions = client.get("/api/v2/auth/sessions",
                          headers=_auth(token)).get_json()["sessions"]
    sid = sessions[0]["session_id"]
    # Sign that device out from another sign-in at store B.
    other = _sign_in(client, b)["access_token"]
    resp = client.delete(f"/api/v2/auth/sessions/{sid}", headers=_auth(other))
    assert resp.status_code == 200
    assert resp.get_json()["revoked"] == 2
    assert _report(client, token, a) == 401


def test_sign_out_other_devices_keeps_this_one_linked(client):
    a, b, ua, ub = _two_stores()
    old = _sign_in(client, a)["access_token"]  # another device
    current = _sign_in(client, a)["access_token"]
    resp = client.delete("/api/v2/auth/sessions/others", headers=_auth(current))
    assert resp.status_code == 200
    # The other device lost store A AND its link to store B …
    assert _report(client, old, a) == 401
    assert _switch(client, old, b).status_code == 401
    # … this one still switches.
    assert _switch(client, current, b).status_code == 200
    assert _live_rows(ua) == 1 and _live_rows(ub) == 1


def test_revoking_someone_elses_session_id_touches_nothing(client):
    a, b, ua, ub = _two_stores()
    token = _sign_in(client, a)["access_token"]
    sid = client.get("/api/v2/auth/sessions",
                     headers=_auth(token)).get_json()["sessions"][0]["session_id"]
    stranger_store = _store("lnk-stranger", "Stranger")
    _user(stranger_store, role="admin", username="stranger@x.example",
          pw="stranger-pass-1")
    stranger = client.post("/api/v2/auth/login", json={
        "username": "stranger@x.example", "password": "stranger-pass-1",
        "store_id": stranger_store,
    }).get_json()["access_token"]
    resp = client.delete(f"/api/v2/auth/sessions/{sid}",
                         headers=_auth(stranger))
    assert resp.get_json()["revoked"] == 0
    assert _live_rows(ua) == 1 and _live_rows(ub) == 1
