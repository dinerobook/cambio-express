"""The "Lock / unlock days" switch (``day_lock.update``).

Locking or unlocking a day on either daily book (MSB and store) needs
Edit on that book AND this switch, so a store admin can let an
employee work a day without letting them re-open it once it is
locked. Admins always hold it; employees hold it by default, which
keeps what they could do before the switch existed (it only bites
together with Edit, which employees do not get by default).

Covers: shipped defaults, grant / deny / revoke through the store
admin's own Roles & access endpoint and a per-person override, both
books' lock and unlock routes, and the single-switch matrix shape
(no create / view / delete rows are ever written or granted).
"""
from __future__ import annotations

import os
from datetime import date

import pytest

from tests._app import db, db_session
from tests.conftest import login_employee

MSB_DAY = date.today().isoformat()
STORE_DAY = "2026-08-02"
PW = "lockperm-pw1!"


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _admin_token(client, store_id: int) -> str:
    return client.post("/api/v2/auth/login", json={
        "username": "admin@test.com", "password": "testpass123!",
        "store_id": store_id,
    }).get_json()["access_token"]


def _employee(store_id: int) -> tuple[int, str]:
    from api.Modules.Tenancy.Models import User
    with db_session():
        username = f"lock_{os.urandom(3).hex()}@test.com"
        u = User(store_id=store_id, username=username,
                 full_name="Cashier", role="employee", is_active=True)
        u.set_password(PW)
        db.session.add(u)
        db.session.commit()
        return u.id, username


def _employee_matrix(client, admin: str) -> dict:
    r = client.get("/api/v2/admin/store-permissions", headers=_h(admin))
    assert r.status_code == 200, r.get_data(as_text=True)
    return r.get_json()["matrix"]["employee"]


def _save_employee_role(client, admin: str, **rows: dict) -> None:
    """Save the store's Employee role the way Roles & access does:
    the whole current grid with ``rows`` replaced."""
    matrix = _employee_matrix(client, admin)
    matrix.update(rows)
    r = client.put(
        "/api/v2/admin/store-permissions",
        json={"matrix": {"employee": matrix}}, headers=_h(admin),
    )
    assert r.status_code == 200, r.get_data(as_text=True)


EDIT_BOTH_BOOKS = {
    "daily_book": {"create": True, "read": True, "update": True, "delete": False},
    "day_close": {"create": True, "read": True, "update": True, "delete": False},
}
LOCK_ON = {"day_lock": {"create": False, "read": False, "update": True, "delete": False}}
LOCK_OFF = {"day_lock": {"create": False, "read": False, "update": False, "delete": False}}


def _lock_msb(client, store_id, token):
    return client.post(f"/api/v2/daily/{store_id}/{MSB_DAY}/lock", headers=_h(token))


def _unlock_msb(client, store_id, token):
    return client.post(f"/api/v2/daily/{store_id}/{MSB_DAY}/unlock", headers=_h(token))


def _lock_store(client, token, locked: bool):
    return client.post(
        f"/api/v2/storebook/{STORE_DAY}/lock",
        json={"locked": locked}, headers=_h(token),
    )


# ── Shipped defaults ────────────────────────────────────────


def test_defaults_admin_and_employee_hold_the_switch():
    from api.Core.Permissions import check_permission
    assert check_permission("admin", 4242, "day_lock", "update") is True
    assert check_permission("employee", 4242, "day_lock", "update") is True
    assert check_permission("superadmin", None, "day_lock", "update") is True


def test_switch_has_only_the_one_action():
    """No create / view / delete for a single switch — not in any
    default, not implied by the grant, not in the superadmin set."""
    from api.Core.Permissions import (
        RBAC_DEFAULTS, actions_for, permissions_for, resolve_grants,
    )
    assert actions_for("day_lock") == ["update"]
    assert actions_for("daily_book") == ["create", "read", "update", "delete"]
    for role, perms in RBAC_DEFAULTS.items():
        extra = [p for p in perms if p.startswith("day_lock.") and p != "day_lock.update"]
        assert extra == [], role
    for role in ("admin", "employee", "owner", "superadmin"):
        grants = resolve_grants(role, 4242)
        assert ("day_lock", "read") not in grants
        assert ("day_lock", "create") not in grants
    assert "day_lock.read" not in permissions_for("owner")


def test_writer_never_stores_an_action_the_switch_does_not_have():
    from casbin_sqlalchemy_adapter import CasbinRule
    from api.Core.Permissions import check_permission, set_store_permissions
    set_store_permissions(9191, "employee", {
        "day_lock": {"create": True, "read": True, "update": True, "delete": True},
    })
    with db_session():
        rows = sorted(
            r.v3 for r in db.session.query(CasbinRule).filter_by(
                v0="employee", v1="9191", v2="day_lock",
            )
        )
    assert rows == ["update"]
    assert check_permission("employee", 9191, "day_lock", "read") is False
    # Off: a __none__ marker, so the store's choice is not lost to
    # the global default.
    set_store_permissions(9191, "employee", LOCK_OFF)
    assert check_permission("employee", 9191, "day_lock", "update") is False


def test_matrix_grants_ignores_actions_the_switch_does_not_have():
    from api.Core.Permissions.ranks import matrix_grants
    grants = matrix_grants({"day_lock": {"read": True, "update": True}})
    assert grants == {("day_lock", "update")}


# ── MSB daily book ──────────────────────────────────────────


def test_admin_locks_and_unlocks_msb_day(client, test_store_id):
    admin = _admin_token(client, test_store_id)
    assert _lock_msb(client, test_store_id, admin).status_code == 200
    r = _unlock_msb(client, test_store_id, admin)
    assert r.status_code == 200
    assert r.get_json()["report"]["locked"] is False


def test_employee_with_edit_keeps_lock_by_default(client, test_store_id):
    """Nothing changes on deploy: an employee given Edit on the daily
    book can still lock and unlock until the admin turns it off."""
    admin = _admin_token(client, test_store_id)
    _save_employee_role(client, admin, **EDIT_BOTH_BOOKS)
    _, username = _employee(test_store_id)
    emp = login_employee(client, test_store_id, username, PW)
    assert _lock_msb(client, test_store_id, emp).status_code == 200
    assert _unlock_msb(client, test_store_id, emp).status_code == 200


def test_admin_turns_switch_off_employee_cannot_lock_or_unlock(
    client, test_store_id,
):
    admin = _admin_token(client, test_store_id)
    _save_employee_role(client, admin, **EDIT_BOTH_BOOKS, **LOCK_OFF)
    assert _employee_matrix(client, admin)["day_lock"]["update"] is False
    _, username = _employee(test_store_id)
    emp = login_employee(client, test_store_id, username, PW)
    assert "day_lock.update" not in client.get(
        "/api/v2/auth/session-status", headers=_h(emp),
    ).get_json()["permissions"]

    r = _lock_msb(client, test_store_id, emp)
    assert r.status_code == 403
    assert "day_lock.update" in r.get_json()["detail"]

    # The admin locks; the employee cannot re-open it.
    assert _lock_msb(client, test_store_id, admin).status_code == 200
    assert _unlock_msb(client, test_store_id, emp).status_code == 403
    assert client.get(
        f"/api/v2/daily/{test_store_id}/{MSB_DAY}", headers=_h(admin),
    ).get_json()["report"]["locked"] is True

    # Editing an open day is untouched by the switch.
    assert _unlock_msb(client, test_store_id, admin).status_code == 200
    r = client.put(
        f"/api/v2/daily/{test_store_id}/{MSB_DAY}",
        json={"notes": "cashier note"}, headers=_h(emp),
    )
    assert r.status_code == 200, r.get_data(as_text=True)


def test_admin_turns_switch_back_on(client, test_store_id):
    admin = _admin_token(client, test_store_id)
    _save_employee_role(client, admin, **EDIT_BOTH_BOOKS, **LOCK_OFF)
    _save_employee_role(client, admin, **LOCK_ON)
    _, username = _employee(test_store_id)
    emp = login_employee(client, test_store_id, username, PW)
    assert _lock_msb(client, test_store_id, emp).status_code == 200


def test_switch_without_edit_does_not_lock(client, test_store_id):
    """The default employee holds the switch but not Edit on the
    book, so they still cannot lock — same as before the switch."""
    admin = _admin_token(client, test_store_id)
    _lock_msb(client, test_store_id, admin)
    _, username = _employee(test_store_id)
    emp = login_employee(client, test_store_id, username, PW)
    r = _unlock_msb(client, test_store_id, emp)
    assert r.status_code == 403
    assert "daily_book.update" in r.get_json()["detail"]


def test_per_person_override_takes_switch_away(client, test_store_id):
    from api.Core.Permissions import set_user_permissions
    admin = _admin_token(client, test_store_id)
    _save_employee_role(client, admin, **EDIT_BOTH_BOOKS)
    uid, username = _employee(test_store_id)
    set_user_permissions(test_store_id, uid, {**EDIT_BOTH_BOOKS, **LOCK_OFF})
    emp = login_employee(client, test_store_id, username, PW)
    assert _lock_msb(client, test_store_id, emp).status_code == 403
    # A colleague on the plain Employee role still has it.
    _, other = _employee(test_store_id)
    assert _lock_msb(
        client, test_store_id, login_employee(client, test_store_id, other, PW),
    ).status_code == 200


def test_store_admin_cannot_take_switch_from_admin_role(client, test_store_id):
    """Admins always hold it: the Admin row is not the store's to edit."""
    admin = _admin_token(client, test_store_id)
    matrix = client.get(
        "/api/v2/admin/store-permissions", headers=_h(admin),
    ).get_json()["matrix"]["admin"]
    matrix.update(LOCK_OFF)
    r = client.put(
        "/api/v2/admin/store-permissions",
        json={"matrix": {"admin": matrix}}, headers=_h(admin),
    )
    assert r.status_code == 403
    assert _lock_msb(client, test_store_id, admin).status_code == 200


# ── Store daily book ────────────────────────────────────────


def test_store_book_lock_follows_the_same_switch(client, test_store_id):
    admin = _admin_token(client, test_store_id)
    _save_employee_role(client, admin, **EDIT_BOTH_BOOKS)
    _, username = _employee(test_store_id)
    emp = login_employee(client, test_store_id, username, PW)
    r = _lock_store(client, emp, True)
    assert r.status_code == 200, r.get_data(as_text=True)
    assert r.get_json()["is_locked"] is True
    assert _lock_store(client, emp, False).get_json()["is_locked"] is False

    _save_employee_role(client, admin, **LOCK_OFF)
    emp = login_employee(client, test_store_id, username, PW)
    assert _lock_store(client, emp, True).status_code == 403
    assert _lock_store(client, admin, True).status_code == 200
    r = _lock_store(client, emp, False)
    assert r.status_code == 403
    assert client.get(
        f"/api/v2/storebook/{STORE_DAY}", headers=_h(admin),
    ).get_json()["is_locked"] is True


@pytest.mark.parametrize("locked", [True, False])
def test_store_book_lock_needs_edit_too(client, test_store_id, locked):
    _, username = _employee(test_store_id)
    emp = login_employee(client, test_store_id, username, PW)
    assert _lock_store(client, emp, locked).status_code == 403


# ── Saved roles ─────────────────────────────────────────────


def test_saved_role_stores_only_the_switch_action(client, test_store_id):
    admin = _admin_token(client, test_store_id)
    r = client.post(
        "/api/v2/admin/roles",
        json={"name": "Closer", "matrix": {
            **EDIT_BOTH_BOOKS,
            "day_lock": {"create": True, "read": True, "update": True, "delete": True},
        }},
        headers=_h(admin),
    )
    assert r.status_code == 201, r.get_data(as_text=True)
    lock = r.get_json()["matrix"]["day_lock"]
    assert lock == {"create": False, "read": False, "update": True, "delete": False}
