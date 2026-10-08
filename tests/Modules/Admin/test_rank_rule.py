"""The rank rule (api/Core/Permissions/ranks.py): who may change
whom on the team pages.

Security-critical. Before this rule (audit of 2026-10-08):
  * a store admin, or anyone holding users.update, could reset the
    OWNER's password at the home store, demote or deactivate them,
    or write a custom-access grid onto them — then sign in as the
    owner across every store in the umbrella;
  * an employee given the Team permission could promote a
    colleague to admin, reset the admin's password, create new
    admins, or hand a colleague (or a saved role) every permission.

The rule under test: you may manage people at or below your own
rank (employee < admin < owner), assign roles at or below it, and
never grant access you do not hold yourself (which only bites on
employee-rank actors; admins hold the whole store).
"""
from tests._app import db, db_session
from tests.conftest import login_admin, login_employee


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


def _login(client, username, password, store_id):
    r = client.post("/api/v2/auth/login", json={
        "username": username, "password": password, "store_id": store_id,
    })
    return r.status_code, r.get_json()


def _give_employee_team_rights(store_id, *, create=False):
    """Employee role: Team edit (and optionally create) on top of
    the defaults. Returns a restore callable."""
    from api.Core.Permissions import (
        get_permission_matrix, reset_store_to_defaults,
        set_store_permissions,
    )
    cur = get_permission_matrix(
        store_id, ["employee"], ["employee"],
    )["matrix"]["employee"]
    cur["users"] = {"read": True, "update": True,
                    "create": create, "delete": False}
    set_store_permissions(store_id, "employee", cur)
    return lambda: reset_store_to_defaults(store_id, "employee")


def _all_on():
    from api.Core.Permissions import RBAC_ACTIONS, RBAC_RESOURCES
    return {r: {a: True for a in RBAC_ACTIONS} for r in RBAC_RESOURCES}


# ── Finding 1: the owner's row is out of a store admin's reach ──


def test_admin_cannot_touch_the_owner_row(client, test_store_id):
    owner_id = _mk_user(
        test_store_id, "owner.rank@test.com", role="owner",
        password="ownerpass123",
    )
    tok = login_admin(client, test_store_id)

    # Visible on the roster, flagged as not manageable.
    rows = client.get("/api/v2/admin/users", headers=_h(tok)).get_json()
    owner_row = next(r for r in rows["rows"] if r["id"] == owner_id)
    assert owner_row["role"] == "owner"
    assert owner_row["can_manage"] is False
    assert rows["assignable_roles"] == ["admin", "employee"]

    for body in (
        {"password": "pwned-pass-1"},
        {"role": "employee"},
        {"is_active": False},
        {"full_name": "Renamed"},
    ):
        r = client.patch(
            f"/api/v2/admin/users/{owner_id}", headers=_h(tok), json=body,
        )
        assert r.status_code == 403, (body, r.text)

    r = client.put(
        f"/api/v2/admin/users/{owner_id}/permissions", headers=_h(tok),
        json={"matrix": {"users": {"read": True}}},
    )
    assert r.status_code == 403, r.text
    r = client.delete(
        f"/api/v2/admin/users/{owner_id}/permissions", headers=_h(tok),
    )
    assert r.status_code == 403, r.text
    r = client.put(
        f"/api/v2/admin/users/{owner_id}/role", headers=_h(tok),
        json={"role_id": None},
    )
    assert r.status_code == 403, r.text

    # The owner still signs in with their own password, as owner.
    status, data = _login(
        client, "owner.rank@test.com", "ownerpass123", test_store_id,
    )
    assert status == 200 and data["role"] == "owner"
    from api.Core.Permissions import user_has_custom_permissions
    assert user_has_custom_permissions(owner_id, test_store_id) is False


def test_owner_inside_their_store_manages_admins_and_self(
    client, test_store_id, test_admin_id,
):
    """An owner's switch-store token (role=admin + owner_id) ranks
    as owner: it can manage the admin, and the owner's own row."""
    owner_id = _mk_user(
        test_store_id, "owner.switch@test.com", role="owner",
        password="ownerpass123",
    )
    status, data = _login(
        client, "owner.switch@test.com", "ownerpass123", test_store_id,
    )
    assert status == 200 and data["role"] == "owner"
    switched = client.post(
        "/api/v2/auth/switch-store", headers=_h(data["access_token"]),
        json={"store_id": test_store_id},
    )
    assert switched.status_code == 200, switched.text
    tok = switched.get_json()["access_token"]

    r = client.patch(
        f"/api/v2/admin/users/{test_admin_id}", headers=_h(tok),
        json={"full_name": "Store Admin"},
    )
    assert r.status_code == 200, r.text
    r = client.patch(
        f"/api/v2/admin/users/{owner_id}", headers=_h(tok),
        json={"full_name": "The Owner"},
    )
    assert r.status_code == 200, r.text
    rows = client.get("/api/v2/admin/users", headers=_h(tok)).get_json()
    assert all(row["can_manage"] for row in rows["rows"])


def test_admin_still_manages_peers_and_employees(client, test_store_id):
    """Unchanged behaviour at equal rank: admins run the store
    together, including each other's logins."""
    peer = _mk_user(test_store_id, "peer.admin@test.com", role="admin")
    emp = _mk_user(test_store_id, "peer.emp@test.com")
    tok = login_admin(client, test_store_id)
    r = client.patch(
        f"/api/v2/admin/users/{peer}", headers=_h(tok),
        json={"password": "new-peer-pass"},
    )
    assert r.status_code == 200, r.text
    r = client.patch(
        f"/api/v2/admin/users/{emp}", headers=_h(tok), json={"role": "admin"},
    )
    assert r.status_code == 200, r.text


# ── Finding 2: the Team permission is not a store takeover ──


def test_employee_with_team_rights_cannot_escalate(
    client, test_store_id, test_admin_id,
):
    restore = _give_employee_team_rights(test_store_id, create=True)
    try:
        actor = _mk_user(test_store_id, "hr.emp@test.com")
        buddy = _mk_user(test_store_id, "buddy.emp@test.com")
        tok = login_employee(
            client, test_store_id, "hr.emp@test.com", password="pw12345678",
        )

        rows = client.get("/api/v2/admin/users", headers=_h(tok)).get_json()
        assert rows["assignable_roles"] == ["employee"]
        by_id = {r["id"]: r for r in rows["rows"]}
        assert by_id[test_admin_id]["can_manage"] is False
        assert by_id[buddy]["can_manage"] is True
        assert by_id[actor]["can_manage"] is True

        # Up the ladder: no.
        r = client.patch(
            f"/api/v2/admin/users/{buddy}", headers=_h(tok),
            json={"role": "admin"},
        )
        assert r.status_code == 403, r.text
        r = client.patch(
            f"/api/v2/admin/users/{test_admin_id}", headers=_h(tok),
            json={"password": "takeover-1"},
        )
        assert r.status_code == 403, r.text
        r = client.post(
            "/api/v2/admin/users", headers=_h(tok), json={
                "email": "new.admin@test.com", "password": "pw12345678",
                "role": "admin",
            },
        )
        assert r.status_code == 403, r.text

        # Sideways with more access than they hold: no.
        r = client.put(
            f"/api/v2/admin/users/{buddy}/permissions", headers=_h(tok),
            json={"matrix": _all_on()},
        )
        assert r.status_code == 403, r.text
        assert "users.delete" in r.get_json()["detail"]
        r = client.post(
            "/api/v2/admin/roles", headers=_h(tok),
            json={"name": "Everything", "matrix": _all_on()},
        )
        assert r.status_code == 403, r.text
        r = client.post(
            "/api/v2/admin/users", headers=_h(tok), json={
                "email": "new.emp@test.com", "password": "pw12345678",
                "role": "employee", "permissions": _all_on(),
            },
        )
        assert r.status_code == 403, r.text

        # Within their own access: yes.
        r = client.patch(
            f"/api/v2/admin/users/{buddy}", headers=_h(tok),
            json={"full_name": "Buddy"},
        )
        assert r.status_code == 200, r.text
        r = client.put(
            f"/api/v2/admin/users/{buddy}/permissions", headers=_h(tok),
            json={"matrix": {"time_clock": {"read": True}}},
        )
        assert r.status_code == 200, r.text
        r = client.post(
            "/api/v2/admin/users", headers=_h(tok), json={
                "email": "new.emp@test.com", "password": "pw12345678",
                "role": "employee",
            },
        )
        assert r.status_code == 201, r.text
    finally:
        restore()


def test_employee_cannot_assign_a_saved_role_beyond_own_access(
    client, test_store_id,
):
    """A saved role made by an admin with every permission is a
    matrix like any other: an employee may not put a colleague
    in it, nor widen a role they may edit beyond their own grants."""
    admin_tok = login_admin(client, test_store_id)
    made = client.post(
        "/api/v2/admin/roles", headers=_h(admin_tok),
        json={"name": "Manager", "matrix": _all_on()},
    )
    assert made.status_code == 201, made.text
    role_id = made.get_json()["id"]
    restore = _give_employee_team_rights(test_store_id)
    try:
        _mk_user(test_store_id, "hr2.emp@test.com")
        buddy = _mk_user(test_store_id, "buddy2.emp@test.com")
        tok = login_employee(
            client, test_store_id, "hr2.emp@test.com", password="pw12345678",
        )
        r = client.put(
            f"/api/v2/admin/users/{buddy}/role", headers=_h(tok),
            json={"role_id": role_id},
        )
        assert r.status_code == 403, r.text
        r = client.put(
            f"/api/v2/admin/roles/{role_id}", headers=_h(tok),
            json={"matrix": _all_on()},
        )
        assert r.status_code == 403, r.text
    finally:
        restore()
        client.delete(f"/api/v2/admin/roles/{role_id}", headers=_h(admin_tok))


def test_employee_cannot_widen_their_own_role_via_store_permissions(
    client, test_store_id,
):
    """Settings edit on an employee lets them edit the Employee
    built-in role — which is their own access. It stays within
    what they already hold."""
    from api.Core.Permissions import (
        get_permission_matrix, reset_store_to_defaults,
        set_store_permissions,
    )
    cur = get_permission_matrix(
        test_store_id, ["employee"], ["employee"],
    )["matrix"]["employee"]
    cur["settings"] = {"read": True, "update": True,
                       "create": False, "delete": False}
    set_store_permissions(test_store_id, "employee", cur)
    try:
        _mk_user(test_store_id, "settings.emp@test.com")
        tok = login_employee(
            client, test_store_id, "settings.emp@test.com",
            password="pw12345678",
        )
        widened = dict(cur)
        widened["users"] = {a: True for a in ("create", "read", "update", "delete")}
        r = client.put(
            "/api/v2/admin/store-permissions", headers=_h(tok),
            json={"matrix": {"employee": widened}},
        )
        assert r.status_code == 403, r.text
    finally:
        reset_store_to_defaults(test_store_id, "employee")


# ── Finding 7: a rejected matrix save writes nothing ──


def test_store_permissions_rejected_body_writes_nothing(
    client, test_store_id,
):
    from api.Core.Permissions import _get_enforcer, get_permission_matrix
    from api.Modules.Audit.Models import OperatorAuditLog
    tok = login_admin(client, test_store_id)
    emp = get_permission_matrix(
        test_store_id, ["employee"], ["employee"],
    )["matrix"]["employee"]
    emp["transfers"] = {"create": False, "read": False,
                        "update": False, "delete": False}
    with db_session():
        n0 = db.session.query(OperatorAuditLog).count()
    before = _get_enforcer().get_filtered_policy(0, "employee", str(test_store_id))

    r = client.put(
        "/api/v2/admin/store-permissions", headers=_h(tok),
        json={"matrix": {"employee": emp, "admin": {}}},
    )
    assert r.status_code == 403
    r2 = client.put(
        "/api/v2/admin/store-permissions", headers=_h(tok),
        json={"matrix": {"employee": "not-a-matrix"}},
    )
    assert r2.status_code == 422

    assert _get_enforcer().get_filtered_policy(
        0, "employee", str(test_store_id),
    ) == before
    with db_session():
        assert db.session.query(OperatorAuditLog).count() == n0


def test_owner_store_permissions_rejected_body_writes_nothing(
    client, test_store_id,
):
    from api.Core.Permissions import _get_enforcer, get_permission_matrix
    from api.Modules.Tenancy.Models import StoreOwnerLink
    owner_id = _mk_user(
        None, "owner.matrix@test.com", role="owner", password="ownerpass123",
    )
    with db_session():
        db.session.add(StoreOwnerLink(owner_id=owner_id, store_id=test_store_id))
        db.session.commit()
    _, data = _login(client, "owner.matrix@test.com", "ownerpass123", None)
    tok = data["access_token"]
    emp = get_permission_matrix(
        test_store_id, ["employee"], ["employee"],
    )["matrix"]["employee"]
    emp["transfers"] = {"create": False, "read": False,
                        "update": False, "delete": False}
    before = _get_enforcer().get_filtered_policy(0, "employee", str(test_store_id))
    r = client.put(
        f"/api/v2/owner/store/{test_store_id}/permissions", headers=_h(tok),
        json={"matrix": {"employee": emp, "admin": {}}},
    )
    assert r.status_code == 403, r.text
    assert _get_enforcer().get_filtered_policy(
        0, "employee", str(test_store_id),
    ) == before


# ── The rule itself ──


def test_rank_helpers():
    from api.Core.Permissions.ranks import (
        actor_rank_role, assignable_roles, can_assign_role, can_manage,
        grants_beyond_ceiling, matrix_grants,
    )
    admin = {"sub": "7", "role": "admin", "store_id": 1}
    owner_in_store = {"sub": "9", "role": "admin", "owner_id": 9, "store_id": 1}
    employee = {"sub": "3", "role": "employee", "store_id": 1}

    assert actor_rank_role(owner_in_store) == "owner"
    assert actor_rank_role(admin) == "admin"
    assert can_manage(admin, "owner") is False
    assert can_manage(admin, "admin") is True
    assert can_manage(owner_in_store, "owner") is True
    assert can_manage(employee, "admin") is False
    assert can_manage(employee, "employee") is True
    assert can_manage(employee, "") is True  # a malformed row is cleanable
    assert assignable_roles(employee) == ["employee"]
    assert assignable_roles(admin) == ["admin", "employee"]
    assert can_assign_role(employee, "admin") is False
    assert can_assign_role(admin, "owner") is False
    # Any write implies read before the ceiling is checked.
    assert matrix_grants({"transfers": {"update": True}}) == {
        ("transfers", "update"), ("transfers", "read"),
    }
    assert grants_beyond_ceiling(admin, 1, {("transfers", "delete")}) == []
