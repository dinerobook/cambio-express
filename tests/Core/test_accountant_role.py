"""The Accountant role (idea D1, 2026-11-04): a store's bookkeeper or
CPA gets a view-only sign-in for Reports, the monthly P&L and the tax
pack. One sign-in per store (owner's choice, "option A"); the owner
adds the same person to several stores with "Add user to stores" and
the sign-in page asks which store to open.

Two locks, both fail closed, and both are pinned here:

1. ``FIXED_ROLE_GRANTS`` — the role's grants are fixed in code; no
   store override and no per-user overlay can change them.
2. ``api/Core/Permissions/accountant.py`` — every route outside the
   accountant's list answers 403 before it runs. The walk below hits
   EVERY route in the app as an accountant.

Plus grant / deny / revoke, store isolation and the rank rule (only
an admin, an owner or the superadmin manages an accountant).
"""
from __future__ import annotations

import re

import pytest
from fastapi.routing import APIRoute

from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin

ACC_EMAIL = "cpa@books.example"
ACC_PW = "ledger-pass-1!"


# ── helpers ─────────────────────────────────────────────────


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _make_store(slug: str, name: str) -> int:
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = Store(name=name, slug=slug, email=f"{slug}@x.com", plan="basic")
        db.session.add(s)
        db.session.commit()
        return s.id


def _make_user(store_id: int, username: str, role: str, pw: str = ACC_PW) -> int:
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, email=username,
                 full_name=username, role=role, is_active=True)
        u.set_password(pw)
        db.session.add(u)
        db.session.commit()
        return u.id


def _login(client, store_id: int, username: str = ACC_EMAIL, pw: str = ACC_PW) -> str:
    resp = client.post(
        "/api/v2/auth/login",
        json={"username": username, "password": pw, "store_id": store_id},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()["access_token"]


def _accountant(client, store_id: int) -> tuple[int, str]:
    uid = _make_user(store_id, ACC_EMAIL, "accountant")
    return uid, _login(client, store_id)


# ── grant ───────────────────────────────────────────────────


def test_admin_adds_an_accountant_who_can_sign_in(client, test_store_id):
    admin = login_admin(client, test_store_id)
    roster = client.get("/api/v2/admin/users", headers=_auth(admin)).get_json()
    assert "accountant" in roster["assignable_roles"]

    resp = client.post(
        "/api/v2/admin/users",
        json={"email": ACC_EMAIL, "password": ACC_PW,
              "full_name": "Our CPA", "role": "accountant"},
        headers=_auth(admin),
    )
    assert resp.status_code == 201, resp.get_data(as_text=True)
    assert resp.get_json()["role"] == "accountant"

    token = _login(client, test_store_id)
    status = client.get("/api/v2/auth/session-status", headers=_auth(token))
    assert status.status_code == 200
    perms = status.get_json()["permissions"]
    assert sorted(p for p in perms if "." in p and not p.startswith(("store.", "owner.", "platform."))) == [
        "monthly.read", "reports.read",
    ]


def test_accountant_reads_reports_pl_and_tax_pack(client, test_store_id):
    _, token = _accountant(client, test_store_id)
    h = _auth(token)
    sid = test_store_id
    assert client.get("/api/v2/reports?collection=msb", headers=h).status_code == 200
    assert client.get(
        f"/api/v2/reports/sales-by-company?store_ids={sid}", headers=h,
    ).status_code == 200
    assert client.get(
        f"/api/v2/reports/period-pl?store_ids={sid}", headers=h,
    ).status_code == 200
    assert client.get(
        f"/api/v2/reports/transfers.csv?store_ids={sid}", headers=h,
    ).status_code == 200
    assert client.get("/api/v2/monthly/months", headers=h).status_code == 200
    assert client.get("/api/v2/monthly/labels", headers=h).status_code == 200
    # Nothing recorded this month yet is a 404, not a refusal.
    assert client.get("/api/v2/monthly/2026/1", headers=h).status_code in (200, 404)
    assert client.get("/api/v2/admin/tax-export/years", headers=h).status_code == 200
    zip_resp = client.get("/api/v2/admin/tax-export.zip?year=2025", headers=h)
    assert zip_resp.status_code == 200
    assert zip_resp.headers["content-type"] == "application/zip"
    # Their own account.
    assert client.get("/api/v2/auth/profile", headers=h).status_code == 200
    assert client.get("/api/v2/announcements/active", headers=h).status_code == 200
    assert client.get("/api/v2/auth/passkeys", headers=h).status_code == 200
    assert client.get("/api/v2/auth/sessions", headers=h).status_code == 200
    assert client.get("/api/v2/auth/activity", headers=h).status_code == 200


def test_data_export_downloads_work_for_an_accountant(client, test_store_id):
    """The Data export page sends ``store_ids=`` empty for the
    transfers and journal CSVs; that must resolve to the
    accountant's own store, like it does for an admin."""
    _, token = _accountant(client, test_store_id)
    for slug in ("transfers", "journal-entries"):
        resp = client.get(
            f"/api/v2/reports/{slug}.csv?from=2026-01-01&to=2026-01-31&store_ids=",
            headers=_auth(token),
        )
        assert resp.status_code == 200, (slug, resp.status_code)


# ── deny: every route outside the list ──────────────────────


def _routes():
    from api.main import api_app
    out = []
    for r in api_app.routes:
        if isinstance(r, APIRoute):
            for m in sorted(r.methods or ()):
                if m != "HEAD":
                    out.append((m, r.path))
    return out


def _concrete(path: str) -> str:
    def sub(match):
        name = match.group(1)
        if name in ("year",):
            return "2026"
        if name in ("month",):
            return "1"
        return "1" if name.endswith("_id") or name == "id" else "x"
    return re.sub(r"\{(\w+)(?::[^}]*)?\}", sub, path)


ROUTES = _routes()


def _public_or_own_key() -> set[tuple[str, str]]:
    from tests.Core.test_route_auth import OWN_KEY, PUBLIC
    return {
        (m, p) for table in (PUBLIC, OWN_KEY) for p, ms in table.items() for m in ms
    }


def test_route_list_names_only_real_routes():
    from api.Core.Permissions.accountant import ACCOUNTANT_ROUTES
    real = set(ROUTES)
    assert sorted(ACCOUNTANT_ROUTES - real) == []


def test_route_list_is_view_only_and_narrow():
    """Every route an accountant reaches is a read, except managing
    their OWN account (profile, password, sessions)."""
    from api.Core.Permissions.accountant import accountant_may_call
    reachable = sorted((m, p) for m, p in ROUTES if accountant_may_call(m, p))
    own_account_writes = {
        ("PUT", "/auth/profile"),
        ("POST", "/auth/change-password"),
        ("DELETE", "/auth/sessions/others"),
        ("DELETE", "/auth/sessions/{session_id}"),
        ("POST", "/auth/passkeys/register/begin"),
        ("POST", "/auth/passkeys/register/finish"),
        ("DELETE", "/auth/passkeys/{passkey_id}"),
        # Moves their own sign-in to their own login at another store.
        ("POST", "/auth/switch-store"),
    }
    for m, p in reachable:
        if (m, p) in own_account_writes:
            continue
        assert m == "GET", (m, p)
        assert p.startswith(("/reports", "/monthly/", "/admin/tax-export", "/auth/", "/announcements/active")), p


@pytest.fixture
def accountant_token(client, test_store_id):
    return _accountant(client, test_store_id)[1]


@pytest.mark.parametrize(
    "method,path",
    [
        (m, p) for m, p in ROUTES
        if (m, p) not in _public_or_own_key()
    ],
)
def test_accountant_is_refused_everywhere_else(client, accountant_token, method, path):
    from api.Core.Permissions.accountant import REFUSED_DETAIL, accountant_may_call
    if accountant_may_call(method, path):
        pytest.skip("on the accountant's list (covered by the grant tests)")
    resp = client._request(
        method, "/api/v2" + _concrete(path), json={},
        headers=_auth(accountant_token),
    )
    assert resp.status_code == 403, (method, path, resp.status_code)
    assert resp.get_json()["detail"] == REFUSED_DETAIL


def test_accountant_cannot_change_the_monthly_pl(client, test_store_id):
    _, token = _accountant(client, test_store_id)
    resp = client.put(
        "/api/v2/monthly/2026/1", json={}, headers=_auth(token),
    )
    assert resp.status_code == 403


# ── store isolation ─────────────────────────────────────────


def test_accountant_sees_only_their_own_store(client, test_store_id):
    other = _make_store("other-books", "Other Books")
    _, token = _accountant(client, test_store_id)
    resp = client.get(
        f"/api/v2/reports/sales-by-company?store_ids={other}",
        headers=_auth(token),
    )
    assert resp.status_code == 403
    resp = client.get(
        f"/api/v2/reports/sales-by-company?store_ids={test_store_id},{other}",
        headers=_auth(token),
    )
    assert resp.status_code == 403


def test_owner_adds_one_accountant_to_several_stores(client):
    """Option A: one login per store, created in one go by the owner;
    the sign-in page asks which store, and each token is scoped to
    the store picked."""
    from api.Modules.Tenancy.Models import StoreOwnerLink, User
    sid_a = _make_store("acc-a", "Books A")
    sid_b = _make_store("acc-b", "Books B")
    with db_session():
        owner = User(store_id=sid_a, username="boss@books.example",
                     email="boss@books.example", role="owner", full_name="Boss")
        owner.set_password("ownerpass1!")
        db.session.add(owner)
        db.session.flush()
        db.session.add(StoreOwnerLink(owner_id=owner.id, store_id=sid_a))
        db.session.add(StoreOwnerLink(owner_id=owner.id, store_id=sid_b))
        db.session.commit()
    owner_token = client.post(
        "/api/v2/auth/login-cross-store",
        json={"username": "boss@books.example", "password": "ownerpass1!"},
    ).get_json()["access_token"]
    resp = client.post(
        "/api/v2/owner/bulk-add-user",
        json={"email": ACC_EMAIL, "password": ACC_PW, "full_name": "CPA",
              "role": "accountant", "store_ids": [sid_a, sid_b]},
        headers=_auth(owner_token),
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.get_json()["created"] == 2
    with db_session():
        roles = {
            u.store_id: u.role
            for u in db.session.query(User).filter_by(username=ACC_EMAIL)
        }
    assert roles == {sid_a: "accountant", sid_b: "accountant"}

    picker = client.post(
        "/api/v2/auth/login-cross-store",
        json={"username": ACC_EMAIL, "password": ACC_PW},
    )
    assert picker.status_code == 409
    stores = picker.get_json()["detail"]["stores"]
    assert {s["store_id"] for s in stores} == {sid_a, sid_b}
    assert {s["role"] for s in stores} == {"accountant"}

    token_a = _login(client, sid_a)
    ok = client.get(f"/api/v2/reports/sales-by-company?store_ids={sid_a}", headers=_auth(token_a))
    assert ok.status_code == 200
    # The store-A sign-in never reaches store B, even though the
    # same person has a store-B login too.
    no = client.get(f"/api/v2/reports/sales-by-company?store_ids={sid_b}", headers=_auth(token_a))
    assert no.status_code == 403


def test_owner_bulk_add_refuses_unknown_roles(client):
    from api.Modules.Tenancy.Models import StoreOwnerLink, User
    sid = _make_store("acc-c", "Books C")
    with db_session():
        owner = User(store_id=sid, username="boss2@books.example",
                     email="boss2@books.example", role="owner")
        owner.set_password("ownerpass1!")
        db.session.add(owner)
        db.session.flush()
        db.session.add(StoreOwnerLink(owner_id=owner.id, store_id=sid))
        db.session.commit()
    token = client.post(
        "/api/v2/auth/login-cross-store",
        json={"username": "boss2@books.example", "password": "ownerpass1!"},
    ).get_json()["access_token"]
    resp = client.post(
        "/api/v2/owner/bulk-add-user",
        json={"email": ACC_EMAIL, "password": ACC_PW,
              "role": "auditor", "store_ids": [sid]},
        headers=_auth(token),
    )
    assert resp.status_code == 422


# ── revoke ──────────────────────────────────────────────────


def test_switching_an_accountant_off_signs_them_out(client, test_store_id):
    uid, token = _accountant(client, test_store_id)
    admin = login_admin(client, test_store_id)
    assert client.get("/api/v2/monthly/months", headers=_auth(token)).status_code == 200
    resp = client.patch(
        f"/api/v2/admin/users/{uid}", json={"is_active": False},
        headers=_auth(admin),
    )
    assert resp.status_code == 200
    assert client.get("/api/v2/monthly/months", headers=_auth(token)).status_code == 401
    # And they cannot sign back in.
    again = client.post(
        "/api/v2/auth/login",
        json={"username": ACC_EMAIL, "password": ACC_PW, "store_id": test_store_id},
    )
    assert again.status_code == 401


def test_changing_the_role_ends_the_accountant_session(client, test_store_id):
    uid, token = _accountant(client, test_store_id)
    admin = login_admin(client, test_store_id)
    resp = client.patch(
        f"/api/v2/admin/users/{uid}", json={"role": "employee"},
        headers=_auth(admin),
    )
    assert resp.status_code == 200
    assert client.get("/api/v2/monthly/months", headers=_auth(token)).status_code == 401


def test_superadmin_can_switch_an_accountant_off(client, test_store_id):
    uid, token = _accountant(client, test_store_id)
    sa = login_superadmin(client)
    resp = client.post(
        f"/api/v2/superadmin/users/{uid}/revoke-sessions", headers=_auth(sa),
    )
    assert resp.status_code in (200, 204), resp.get_data(as_text=True)
    assert client.get("/api/v2/monthly/months", headers=_auth(token)).status_code == 401


# ── fixed access ────────────────────────────────────────────


def test_fixed_grants_ignore_store_and_user_rows(test_store_id):
    """Rows written for the accountant (directly, bypassing every
    route guard) change nothing: the resolver never reads them."""
    from api.Core.Permissions import (
        RBAC_RESOURCES, actions_for, check_permission, permissions_for,
        set_store_permissions, set_user_permissions,
    )
    full = {r: {a: True for a in actions_for(r)} for r in RBAC_RESOURCES}
    uid = _make_user(test_store_id, ACC_EMAIL, "accountant")
    set_store_permissions(test_store_id, "accountant", full)
    set_user_permissions(test_store_id, uid, full)
    for resource in RBAC_RESOURCES:
        for action in actions_for(resource):
            expected = (resource, action) in {("reports", "read"), ("monthly", "read")}
            assert check_permission(
                "accountant", test_store_id, resource, action, user_id=uid,
            ) is expected, (resource, action)
    assert set(permissions_for("accountant", store_id=test_store_id, user_id=uid)) == {
        "reports.read", "monthly.read",
    }


def test_custom_access_and_saved_roles_are_refused_for_accountants(client, test_store_id):
    admin = login_admin(client, test_store_id)
    uid = _make_user(test_store_id, ACC_EMAIL, "accountant")
    grid = {"daily_book": {"read": True}}
    resp = client.put(
        f"/api/v2/admin/users/{uid}/permissions", json={"matrix": grid},
        headers=_auth(admin),
    )
    assert resp.status_code == 422
    role = client.post(
        "/api/v2/admin/roles",
        json={"name": "Read books", "matrix": grid},
        headers=_auth(admin),
    )
    assert role.status_code in (200, 201), role.get_data(as_text=True)
    resp = client.put(
        f"/api/v2/admin/users/{uid}/role", json={"role_id": role.get_json()["id"]},
        headers=_auth(admin),
    )
    assert resp.status_code == 422
    resp = client.post(
        "/api/v2/admin/users",
        json={"email": "cpa2@books.example", "password": ACC_PW,
              "role": "accountant", "permissions": grid},
        headers=_auth(admin),
    )
    assert resp.status_code == 422


def test_making_someone_an_accountant_drops_their_custom_access(client, test_store_id):
    from api.Core.Permissions import user_has_custom_permissions
    from api.Modules.Tenancy.Models import User
    admin = login_admin(client, test_store_id)
    uid = _make_user(test_store_id, "clerk@books.example", "employee")
    resp = client.put(
        f"/api/v2/admin/users/{uid}/permissions",
        json={"matrix": {"daily_book": {"read": True, "update": True}}},
        headers=_auth(admin),
    )
    assert resp.status_code == 200
    assert user_has_custom_permissions(uid, test_store_id)
    resp = client.patch(
        f"/api/v2/admin/users/{uid}", json={"role": "accountant"},
        headers=_auth(admin),
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert not user_has_custom_permissions(uid, test_store_id)
    with db_session():
        assert db.session.get(User, uid).store_role_id is None


# ── rank rule ───────────────────────────────────────────────


def _team_employee(client, store_id: int) -> str:
    """An employee who was given the whole Team area."""
    from api.Core.Permissions import set_user_permissions
    uid = _make_user(store_id, "lead@books.example", "employee")
    set_user_permissions(store_id, uid, {
        "users": {"create": True, "read": True, "update": True, "delete": True},
    })
    return _login(client, store_id, "lead@books.example")


def test_an_employee_with_team_access_cannot_add_an_accountant(client, test_store_id):
    lead = _team_employee(client, test_store_id)
    roster = client.get("/api/v2/admin/users", headers=_auth(lead)).get_json()
    assert roster["assignable_roles"] == ["employee"]
    resp = client.post(
        "/api/v2/admin/users",
        json={"email": ACC_EMAIL, "password": ACC_PW, "role": "accountant"},
        headers=_auth(lead),
    )
    assert resp.status_code == 403


def test_an_employee_with_team_access_cannot_touch_an_accountant(client, test_store_id):
    uid = _make_user(test_store_id, ACC_EMAIL, "accountant")
    lead = _team_employee(client, test_store_id)
    for body in ({"password": "taken-over-1!"}, {"is_active": False}, {"full_name": "x"}):
        resp = client.patch(
            f"/api/v2/admin/users/{uid}", json=body, headers=_auth(lead),
        )
        assert resp.status_code == 403, body
    # Nor promote a colleague into one.
    emp = _make_user(test_store_id, "clerk@books.example", "employee")
    resp = client.patch(
        f"/api/v2/admin/users/{emp}", json={"role": "accountant"},
        headers=_auth(lead),
    )
    assert resp.status_code == 403


def test_rank_helpers():
    from api.Core.Permissions.ranks import (
        assignable_roles, can_manage, grant_ceiling,
    )
    admin = {"role": "admin", "sub": "1", "store_id": 1}
    employee = {"role": "employee", "sub": "2", "store_id": 1}
    accountant = {"role": "accountant", "sub": "3", "store_id": 1}
    owner_ctx = {"role": "admin", "sub": "4", "owner_id": "4", "store_id": 1}
    assert can_manage(admin, "accountant")
    assert can_manage(owner_ctx, "accountant")
    assert not can_manage(employee, "accountant")
    assert "accountant" in assignable_roles(admin)
    assert assignable_roles(employee) == ["employee"]
    # An accountant manages nobody and hands out nothing.
    assert assignable_roles(accountant) == []
    for role in ("employee", "admin", "accountant", "owner"):
        assert not can_manage(accountant, role)
    assert grant_ceiling(accountant, 1) is not None
