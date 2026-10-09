"""Endpoint tests for ``GET /auth/session-status`` (PR C).

The SPA shell calls this on load to decide whether to gate the user
out to a re-subscribe / suspended screen. Every authed role can call
it. Read-only — no login/token logic touched.
"""
from tests._app import db, db_session
from tests.conftest import login_admin, login_employee, login_superadmin


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


def _set_store(store_id, **fields):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = db.session.get(Store, store_id)
        for k, v in fields.items():
            setattr(s, k, v)
        db.session.commit()


def test_active_trial_store_not_gated(client, test_store_id):
    # Seeded test store is a trial ending in +7 days → active.
    token = login_admin(client, test_store_id)
    resp = client.get("/api/v2/auth/session-status", headers=_headers(token))
    assert resp.status_code == 200
    body = resp.json()
    assert body["gated"] is False
    assert body["reason"] == ""


def test_inactive_plan_store_is_subscription_gated(client, test_store_id):
    _set_store(test_store_id, plan="inactive")
    token = login_admin(client, test_store_id)
    resp = client.get("/api/v2/auth/session-status", headers=_headers(token))
    assert resp.status_code == 200
    body = resp.json()
    assert body["gated"] is True
    assert body["reason"] == "subscription"
    assert body["plan"] == "inactive"


def test_frozen_store_is_frozen_gated(client, test_store_id):
    from api.Core.Clock import utc_now
    _set_store(test_store_id, frozen_at=utc_now(), frozen_reason="abuse")
    token = login_admin(client, test_store_id)
    resp = client.get("/api/v2/auth/session-status", headers=_headers(token))
    assert resp.status_code == 200
    body = resp.json()
    assert body["gated"] is True
    assert body["reason"] == "frozen"
    # The operator reason is NOT surfaced to the store's users.
    assert "abuse" not in resp.text


def test_superadmin_never_gated(client, test_store_id):
    # Even if a store is frozen, the superadmin (no store scope) is not
    # gated — they operate the platform.
    from api.Core.Clock import utc_now
    _set_store(test_store_id, frozen_at=utc_now())
    token = login_superadmin(client)
    resp = client.get("/api/v2/auth/session-status", headers=_headers(token))
    assert resp.status_code == 200
    assert resp.json()["gated"] is False


def test_requires_auth(client):
    resp = client.get("/api/v2/auth/session-status")
    assert resp.status_code in (401, 403)


def test_permissions_are_live_not_the_token_claim(client, test_store_id):
    """An access token minted BEFORE the admin restricts this person
    still verifies for up to its TTL, carrying the old ``perms``
    claim the SPA gates its nav on. session-status must answer with
    the live list so the shell drops the revoked pages now, not at
    token expiry (the "employee can still open the MSB daily book"
    report)."""
    from api.Core.Permissions import (
        clear_user_permissions, set_user_permissions,
    )
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(
            store_id=test_store_id, username="ss_live_emp",
            role="employee", is_active=True,
        )
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()
        uid = u.id
    token = login_employee(
        client, test_store_id, "ss_live_emp", "emppass1234",
    )
    before = client.get(
        "/api/v2/auth/session-status", headers=_headers(token),
    ).json()["permissions"]
    assert "daily_book.read" in before
    assert "transfers.create" in before

    set_user_permissions(test_store_id, uid, {
        "transfers": {"create": True, "read": True},
        "customers": {"create": True, "read": True},
    })
    try:
        after = client.get(
            "/api/v2/auth/session-status", headers=_headers(token),
        ).json()["permissions"]
    finally:
        clear_user_permissions(test_store_id, uid)
    # Same token, live answer.
    assert "daily_book.read" not in after
    assert "transfers.create" in after
    assert "customers.read" in after
    # Never wider than the claim would have been: the legacy
    # scope marker rides along exactly as permissions_for bakes it.
    assert "store.employee" in after


def test_superadmin_permissions_are_the_full_matrix(client):
    from api.Core.Permissions import RBAC_RESOURCES, actions_for
    token = login_superadmin(client)
    perms = client.get(
        "/api/v2/auth/session-status", headers=_headers(token),
    ).json()["permissions"]
    for r in RBAC_RESOURCES:
        for a in actions_for(r):
            assert f"{r}.{a}" in perms


# ── timezone: the zone every date/time in the SPA renders in ────


def _set_user_tz(username, tz):
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = db.session.query(User).filter_by(username=username).first()
        u.timezone = tz
        db.session.commit()


def test_timezone_is_the_stores(client, test_store_id):
    _set_store(test_store_id, timezone="America/Chicago")
    token = login_admin(client, test_store_id)
    resp = client.get("/api/v2/auth/session-status", headers=_headers(token))
    assert resp.json()["timezone"] == "America/Chicago"


def test_employee_gets_the_store_timezone_without_settings_rights(
    client, test_store_id,
):
    # Employees cannot read /admin/store-info, yet every time they
    # see (the daily-book lock, their punches) must be on store time.
    _set_store(test_store_id, timezone="America/Los_Angeles")
    from tests.conftest import make_employee_client
    _emp_client, token = make_employee_client(test_store_id)
    resp = client.get("/api/v2/auth/session-status", headers=_headers(token))
    assert resp.status_code == 200
    assert resp.json()["timezone"] == "America/Los_Angeles"


def test_timezone_blank_when_store_has_none(client, test_store_id):
    _set_store(test_store_id, timezone="")
    token = login_admin(client, test_store_id)
    resp = client.get("/api/v2/auth/session-status", headers=_headers(token))
    # "" = the device's own zone, exactly the behaviour before.
    assert resp.json()["timezone"] == ""


def test_store_timezone_wins_over_the_persons(client, test_store_id):
    _set_store(test_store_id, timezone="America/Chicago")
    _set_user_tz("admin@test.com", "Asia/Manila")
    token = login_admin(client, test_store_id)
    resp = client.get("/api/v2/auth/session-status", headers=_headers(token))
    assert resp.json()["timezone"] == "America/Chicago"


def test_superadmin_gets_their_own_timezone(client):
    _set_user_tz("superadmin", "America/New_York")
    token = login_superadmin(client)
    resp = client.get("/api/v2/auth/session-status", headers=_headers(token))
    assert resp.json()["timezone"] == "America/New_York"
