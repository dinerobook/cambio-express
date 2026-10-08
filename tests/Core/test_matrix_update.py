"""The one path every "replace a role's permission matrix" route
takes (``api/Core/Permissions/matrix_update.py``), and the one
session-revoking write (``revoke_refresh_tokens``).

Before (audit of 2026-10-08, finding 11 and the cleanup list): three
controllers carried their own copy of the loop and had drifted —
the Owners and Superadmin routes silently DROPPED a role the caller
may not edit instead of refusing, the Superadmin route audited an
empty body, every route accepted a cell-by-cell ``changes`` body
that bypassed the ceiling checks, a malformed body was a 500 out of
the writer, impersonation baked the bare role's permissions rather
than the person's own overlay, and session revocation was four
inline copies of the same UPDATE.
"""
import jwt
import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee, login_superadmin


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _mk_user(store_id, username, role="employee", password="pw12345678"):
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, role=role,
                 is_active=True)
        u.set_password(password)
        db.session.add(u)
        db.session.commit()
        return u.id


def _superadmin_audit_rows(action):
    from api.Modules.Audit.Models import SuperadminAuditLog
    with db_session():
        return (
            db.session.query(SuperadminAuditLog)
            .filter(SuperadminAuditLog.action == action)
            .count()
        )


# ── A role the caller may not edit is refused, not dropped ──


def test_superadmin_store_route_refuses_the_owner_row(client, test_store_id):
    from api.Core.Permissions import _get_enforcer
    sa = login_superadmin(client)
    before = _superadmin_audit_rows("update_store_permissions")
    r = client.put(
        f"/api/v2/superadmin/stores/{test_store_id}/permissions",
        headers=_h(sa),
        json={"matrix": {
            "employee": {"transfers": {"read": True}},
            "owner": {"transfers": {"read": False}},
        }},
    )
    assert r.status_code == 403, r.text
    e = _get_enforcer()
    assert not e.get_filtered_policy(0, "employee", str(test_store_id))
    assert not e.get_filtered_policy(0, "owner", str(test_store_id))
    assert _superadmin_audit_rows("update_store_permissions") == before


def test_superadmin_global_route_refuses_the_superadmin_row(client):
    sa = login_superadmin(client)
    r = client.put(
        "/api/v2/superadmin/permissions", headers=_h(sa),
        json={"matrix": {"superadmin": {"transfers": {"read": False}}}},
    )
    assert r.status_code == 403


# ── Nothing to save is a 422, and audits nothing ──


def test_empty_global_body_is_422_and_unaudited(client):
    sa = login_superadmin(client)
    before = _superadmin_audit_rows("update_permissions")
    assert client.put(
        "/api/v2/superadmin/permissions", headers=_h(sa),
        json={"matrix": {}},
    ).status_code == 422
    assert client.put(
        "/api/v2/superadmin/permissions", headers=_h(sa),
        json={},
    ).status_code == 422
    assert client.put(
        "/api/v2/superadmin/permissions", headers=_h(sa),
        json={"changes": [{"role": "admin", "resource": "transfers",
                           "action": "read", "allowed": False}]},
    ).status_code == 422
    assert _superadmin_audit_rows("update_permissions") == before


# ── Typed bodies: garbage is a 422, never a 500 ──


def test_role_and_overlay_bodies_are_validated(client, test_store_id):
    tok = login_admin(client, test_store_id)
    uid = _mk_user(test_store_id, "typed.body@test.com")
    bad = [
        ("post", "/api/v2/admin/roles", {"matrix": "nope"}),
        ("post", "/api/v2/admin/roles", {"name": "", "matrix": {}}),
        ("post", "/api/v2/admin/roles",
         {"name": "X", "matrix": {"transfers": {"read": "yes"}}}),
        ("post", "/api/v2/admin/roles",
         {"name": "X", "matrix": {"nope": {"read": True}}}),
        ("put", f"/api/v2/admin/users/{uid}/role", {"role_id": "abc"}),
        ("put", f"/api/v2/admin/users/{uid}/role", {"role_id": 0}),
        ("put", f"/api/v2/admin/users/{uid}/permissions", {}),
        ("put", f"/api/v2/admin/users/{uid}/permissions",
         {"matrix": {"transfers": {"nuke": True}}}),
        ("put", f"/api/v2/admin/users/{uid}/permissions",
         {"matrix": {"transfers": {"read": True}}, "changes": []}),
        ("post", "/api/v2/admin/store-permissions/reset", {}),
        ("post", "/api/v2/admin/store-permissions/reset", {"role": ""}),
    ]
    for method, url, body in bad:
        r = getattr(client, method)(url, headers=_h(tok), json=body)
        assert r.status_code == 422, (method, url, body, r.status_code, r.text)
    # And the well-formed versions still work.
    r = client.put(
        f"/api/v2/admin/users/{uid}/role", headers=_h(tok),
        json={"role_id": None},
    )
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v2/admin/store-permissions/reset", headers=_h(tok),
        json={"role": "employee"},
    )
    assert r.status_code == 200, r.text


# ── A matrix save is one transaction with its audit row ──


def test_matrix_save_rolls_back_whole_when_the_audit_fails(
    client, test_store_id, monkeypatch,
):
    from api.Core.Permissions import _get_enforcer
    import api.Modules.Admin.Controllers as C
    _mk_user(test_store_id, "rollback.emp@test.com")
    emp_tok = login_employee(
        client, test_store_id, "rollback.emp@test.com", password="pw12345678",
    )
    tok = login_admin(client, test_store_id)
    cur = client.get(
        "/api/v2/admin/store-permissions", headers=_h(tok),
    ).json()["matrix"]["employee"]
    cur["settings"]["delete"] = True

    def boom(*a, **k):
        raise RuntimeError("audit store down")
    monkeypatch.setattr(C, "_audit_admin_action", boom)
    try:
        r = client.put(
            "/api/v2/admin/store-permissions", headers=_h(tok),
            json={"matrix": {"employee": cur}},
        )
        assert r.status_code >= 500
    except RuntimeError:
        pass  # a test client that re-raises server errors
    monkeypatch.undo()
    # Nothing landed: no override row, and the employee's session
    # was not revoked.
    assert not _get_enforcer().get_filtered_policy(
        0, "employee", str(test_store_id),
    )
    assert client.get(
        "/api/v2/admin/store-permissions", headers=_h(tok),
    ).json()["matrix"]["employee"]["settings"]["delete"] is False
    assert client.get(
        "/api/v2/auth/me", headers=_h(emp_tok),
    ).status_code == 200


# ── A global edit signs out every login of that role, everywhere ──


def test_global_edit_signs_out_the_role_platform_wide(client, test_store_id):
    from api.Core.Permissions import reset_store_to_defaults
    sa = login_superadmin(client)
    admin_tok = login_admin(client, test_store_id)
    assert client.get("/api/v2/auth/me", headers=_h(admin_tok)).status_code == 200
    grid = client.get(
        "/api/v2/superadmin/permissions", headers=_h(sa),
    ).json()["matrix"]["admin"]
    try:
        r = client.put(
            "/api/v2/superadmin/permissions", headers=_h(sa),
            json={"matrix": {"admin": grid}},
        )
        assert r.status_code == 200, r.text
        assert client.get("/api/v2/auth/me", headers=_h(admin_tok)).status_code == 401
    finally:
        # Put the global admin row back exactly as it was.
        client.put(
            "/api/v2/superadmin/permissions", headers=_h(sa),
            json={"matrix": {"admin": grid}},
        )
        reset_store_to_defaults(test_store_id, "employee")


# ── Impersonation carries the person's own access ──


def test_impersonation_token_honours_the_overlay(client, test_store_id):
    from api.Core.Permissions import (
        RBAC_ACTIONS, RBAC_RESOURCES, set_user_permissions,
    )
    uid = _mk_user(test_store_id, "impersonate.me@test.com")
    grid = {r: {a: True for a in RBAC_ACTIONS} for r in RBAC_RESOURCES}
    grid["transfers"] = {a: False for a in RBAC_ACTIONS}
    set_user_permissions(test_store_id, uid, grid)
    sa = login_superadmin(client)
    r = client.post(f"/api/v2/superadmin/impersonate/{uid}", headers=_h(sa))
    assert r.status_code == 200, r.text
    perms = jwt.decode(
        r.json()["token"], options={"verify_signature": False},
    )["perms"]
    assert "transfers.read" not in perms
    assert "customers.read" in perms


# ── The one revoke helper ──


def test_revoke_refresh_tokens_scopes(client, test_store_id):
    from api.Modules.Auth.Services.principal import revoke_refresh_tokens
    from tests._app import db as _db
    a = login_admin(client, test_store_id)
    _mk_user(test_store_id, "scopes.emp@test.com")
    e = login_employee(
        client, test_store_id, "scopes.emp@test.com", password="pw12345678",
    )
    with db_session():
        with pytest.raises(ValueError):
            revoke_refresh_tokens(_db.session)
        # Role at a store: only that role.
        assert revoke_refresh_tokens(
            _db.session, store_id=test_store_id, role="employee",
        ) >= 1
        _db.session.commit()
    assert client.get("/api/v2/auth/me", headers=_h(e)).status_code == 401
    assert client.get("/api/v2/auth/me", headers=_h(a)).status_code == 200
    with db_session():
        # Already-revoked rows are not counted twice.
        assert revoke_refresh_tokens(
            _db.session, store_id=test_store_id, role="employee",
        ) == 0
