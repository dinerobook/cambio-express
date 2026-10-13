"""POST /api/v2/superadmin/stores/{store_id}/permissions/reset.

Drops one role's per-store permission overrides so the store falls
back to the platform defaults. A privilege-changing superadmin
mutation, so pinned: it really clears the overlay, it writes the
audit row (CLAUDE.md invariant 7), it signs the affected role out
(invariant 18 — sessions end through revoke_refresh_tokens), and a
store admin, an uneditable role, an unknown store and a malformed
body change nothing.
"""
from tests._app import db, db_session
from tests.conftest import login_admin, login_employee, login_superadmin


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _url(store_id):
    return f"/api/v2/superadmin/stores/{store_id}/permissions/reset"


def _restrict_employees(store_id):
    """Store override: employees may read transfers but not create them."""
    from api.Core.Permissions import set_store_permissions
    set_store_permissions(store_id, "employee", {
        "transfers": {"read": True, "create": False},
        "customers": {"read": True},
    })


def _employee_can_create_transfers(store_id):
    from api.Core.Permissions import check_permission
    return check_permission("employee", store_id, "transfers", "create")


def _audit_rows(action="reset_store_permissions"):
    from api.Modules.Audit.Models import SuperadminAuditLog
    with db_session():
        return [
            (r.action, r.target_id, r.details, r.admin_name)
            for r in db.session.query(SuperadminAuditLog).filter_by(action=action)
        ]


def _seed_employee(store_id, username="reset_emp"):
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, role="employee",
                 is_active=True)
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()


def test_superadmin_reset_clears_the_override_and_audits(client, test_store_id):
    _restrict_employees(test_store_id)
    assert _employee_can_create_transfers(test_store_id) is False

    resp = client.post(_url(test_store_id), headers=_h(login_superadmin(client)),
                       json={"role": "employee"})
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json()
    assert "employee" not in body["has_overrides"]
    assert body["matrix"]["employee"]["transfers"]["create"] is True
    assert body["store_name"] == "Test Store"
    assert _employee_can_create_transfers(test_store_id) is True

    rows = _audit_rows()
    assert len(rows) == 1
    action, target_id, details, admin_name = rows[0]
    assert target_id == str(test_store_id)
    assert "employee" in details and "Test Store" in details
    assert admin_name


def test_reset_leaves_the_other_role_alone(client, test_store_id):
    from api.Core.Permissions import set_store_permissions
    _restrict_employees(test_store_id)
    set_store_permissions(test_store_id, "admin", {"transfers": {"read": True}})
    resp = client.post(_url(test_store_id), headers=_h(login_superadmin(client)),
                       json={"role": "employee"})
    assert resp.status_code == 200
    assert resp.get_json()["has_overrides"] == ["admin"]


def test_reset_signs_the_roles_sessions_out(client, test_store_id):
    _seed_employee(test_store_id)
    emp = _h(login_employee(client, test_store_id, "reset_emp", "emppass1234"))
    assert client.get("/api/v2/auth/session-status", headers=emp).status_code == 200

    resp = client.post(_url(test_store_id), headers=_h(login_superadmin(client)),
                       json={"role": "employee"})
    assert resp.status_code == 200
    # Drop the superadmin's cookie so only the employee's bearer
    # token is on the next call.
    from tests.conftest import _starlette_client
    _starlette_client.cookies.clear()
    assert client.get("/api/v2/auth/session-status", headers=emp).status_code == 401


def test_a_store_admin_is_refused_and_nothing_changes(client, test_store_id):
    _restrict_employees(test_store_id)
    resp = client.post(_url(test_store_id), headers=_h(login_admin(client, test_store_id)),
                       json={"role": "employee"})
    assert resp.status_code == 403
    assert _employee_can_create_transfers(test_store_id) is False
    assert _audit_rows() == []


def test_an_employee_is_refused(client, test_store_id):
    _seed_employee(test_store_id)
    emp = _h(login_employee(client, test_store_id, "reset_emp", "emppass1234"))
    assert client.post(_url(test_store_id), headers=emp,
                       json={"role": "employee"}).status_code == 403


def test_anonymous_is_401(client, test_store_id):
    assert client.post(_url(test_store_id), json={"role": "employee"}).status_code == 401


def test_a_role_outside_admin_and_employee_is_refused(client, test_store_id):
    resp = client.post(_url(test_store_id), headers=_h(login_superadmin(client)),
                       json={"role": "owner"})
    assert resp.status_code == 403
    assert _audit_rows() == []


def test_an_unknown_store_is_404(client):
    resp = client.post(_url(999999), headers=_h(login_superadmin(client)),
                       json={"role": "employee"})
    assert resp.status_code == 404
    assert _audit_rows() == []


def test_a_malformed_body_is_422(client, test_store_id):
    sa = _h(login_superadmin(client))
    assert client.post(_url(test_store_id), headers=sa, json={}).status_code == 422
    assert client.post(_url(test_store_id), headers=sa,
                       json={"role": "employee", "extra": 1}).status_code == 422
    assert _audit_rows() == []
