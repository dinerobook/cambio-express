"""The one permission writer and the one resolver.

Audit of 2026-10-08, findings 3, 5, 6, 8 and 9:

* every write replaces one subject's rows in ONE transaction, so a
  reader never sees "no rows" between a delete and its inserts and
  two writers never leave a union behind;
* the global layer stores "explicitly off" like the store layer
  does, so all-off is all-off and not "unseeded, use defaults";
* a principal with no store scope (an owner's umbrella token)
  resolves against the global rows, so superadmin edits to the
  owner row apply to owners;
* a new resource's defaults are seeded once per database, and a
  superadmin's explicit off is never undone by a boot;
* a saved role's propagation commits with the role rows or not at
  all.
"""
import pytest

from tests._app import db, db_session


def _mk_user(store_id, username, role="employee"):
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, role=role,
                 is_active=True)
        u.set_password("pw12345678")
        db.session.add(u)
        db.session.commit()
        return u.id


def _rows(subject, domain):
    from casbin_sqlalchemy_adapter import CasbinRule
    with db_session():
        return sorted(
            (r.v2, r.v3)
            for r in db.session.query(CasbinRule)
            .filter(CasbinRule.v0 == subject, CasbinRule.v1 == domain)
        )


def _all_off():
    from api.Core.Permissions import RBAC_ACTIONS, RBAC_RESOURCES
    return {r: {a: False for a in RBAC_ACTIONS} for r in RBAC_RESOURCES}


@pytest.fixture
def restore_global():
    """Put the global rows back exactly as they were."""
    from casbin_sqlalchemy_adapter import CasbinRule
    import api.Core.Permissions as P
    with db_session():
        before = [
            (r.v0, r.v2, r.v3)
            for r in db.session.query(CasbinRule).filter(CasbinRule.v1 == "global")
        ]
    yield
    by_role: dict = {}
    for role, res, act in before:
        by_role.setdefault(role, []).append((res, act))
    P._replace_subject_rows("global", {r: by_role.get(r) for r in ("admin", "employee", "owner")})


# ── Finding 5: global all-off means all off ──


def test_global_all_off_resolves_to_nothing(restore_global):
    from api.Core.Permissions import (
        check_permission, get_global_matrix, permissions_for,
        set_global_permissions,
    )
    set_global_permissions("owner", _all_off())
    assert check_permission("owner", None, "settings", "update") is False
    assert check_permission("owner", 777, "settings", "update") is False
    assert [p for p in permissions_for("owner") if "." in p and not p.startswith("owner.")] == []
    shown = get_global_matrix()["matrix"]["owner"]
    assert not any(v for row in shown.values() for v in row.values())


def test_global_rows_are_a_per_resource_overlay(restore_global):
    """A global save mentions every current resource; a resource
    added later falls back to the shipped default for that
    resource only."""
    import api.Core.Permissions as P
    from api.Core.Permissions import check_permission, set_global_permissions
    m = _all_off()
    m["transfers"] = {"read": True, "create": False, "update": False, "delete": False}
    set_global_permissions("employee", m)
    assert check_permission("employee", 777, "transfers", "read") is True
    assert check_permission("employee", 777, "lottery", "read") is False
    # Pretend lottery joined the platform after that save: drop its
    # marker and the default for it comes back, nothing else moves.
    rows = [(r, a) for r, a in _rows("employee", "global") if r != "lottery"]
    P._replace_subject_rows("global", {"employee": rows})
    assert check_permission("employee", 777, "lottery", "read") is True
    assert check_permission("employee", 777, "transfers", "create") is False


# ── Finding 6: no store scope resolves against the global rows ──


def test_storeless_principal_honours_global_rows(restore_global):
    from api.Core.Permissions import (
        check_permission, get_global_matrix, permissions_for,
        set_global_permissions,
    )
    assert check_permission("owner", None, "settings", "update") is True
    m = get_global_matrix()["matrix"]["owner"]
    m["settings"] = {"create": False, "read": True, "update": False, "delete": False}
    set_global_permissions("owner", m)
    assert check_permission("owner", None, "settings", "update") is False
    assert check_permission("owner", None, "settings", "read") is True
    assert "settings.update" not in permissions_for("owner")


# ── Finding 3: seed once, never undo an explicit off ──


def test_boot_seeds_a_new_resource_once(restore_global):
    from api.Core.Boot import seed_new_resources
    from api.Core.Permissions import check_permission, get_global_matrix, set_global_permissions
    with db_session():
        assert seed_new_resources(db.session) == [
            "lottery", "day_close", "catalog", "day_lock",
        ]
    m = get_global_matrix()["matrix"]["employee"]
    m["lottery"] = {a: False for a in ("create", "read", "update", "delete")}
    set_global_permissions("employee", m)
    assert check_permission("employee", 777, "lottery", "create") is False
    with db_session():
        assert seed_new_resources(db.session) == []  # already seeded
    assert check_permission("employee", 777, "lottery", "create") is False


def test_additive_seed_skips_a_role_that_mentions_the_resource(restore_global):
    import api.Core.Permissions as P
    from api.Core.Permissions import check_permission, ensure_resource_defaults, set_global_permissions
    m = P.get_global_matrix()["matrix"]["employee"]
    m["lottery"] = {a: False for a in ("create", "read", "update", "delete")}
    set_global_permissions("employee", m)  # writes a __none__ marker
    assert ensure_resource_defaults("lottery") == 0
    assert check_permission("employee", 777, "lottery", "create") is False
    # A role with NO row for the resource (a save from before it
    # existed) does get the default, once.
    rows = [(r, a) for r, a in _rows("employee", "global") if r != "lottery"]
    P._replace_subject_rows("global", {"employee": rows})
    assert ensure_resource_defaults("lottery") == 2
    assert ("lottery", "create") in _rows("employee", "global")


# ── Finding 8: one transaction, last writer wins ──


def test_a_rolled_back_write_leaves_the_rows_untouched(test_store_id):
    from api.Core.Permissions import (
        check_permission, reset_store_to_defaults, set_store_permissions,
    )
    try:
        set_store_permissions(test_store_id, "employee", {"transfers": {"read": True}})
        before = _rows("employee", str(test_store_id))
        with db_session():
            set_store_permissions(
                test_store_id, "employee", {"users": {"read": True}},
                session=db.session,
            )
            db.session.rollback()
        assert _rows("employee", str(test_store_id)) == before
        assert check_permission("employee", test_store_id, "transfers", "read") is True
        assert check_permission("employee", test_store_id, "users", "read") is False
    finally:
        reset_store_to_defaults(test_store_id, "employee")


def test_a_committed_session_write_is_enforced_at_once(test_store_id, monkeypatch):
    """The rows join the caller's transaction, and this worker's
    copy is reloaded by the commit itself — no caller has to
    remember to."""
    import api.Core.Permissions as P
    from api.Core.Permissions import check_permission, reset_store_to_defaults, set_store_permissions
    monkeypatch.setattr(P, "_RELOAD_INTERVAL", 3600.0)
    P.reload_policy()
    try:
        with db_session():
            set_store_permissions(
                test_store_id, "employee", {"users": {"read": True}},
                session=db.session,
            )
            # Not committed yet: nothing changed for readers.
            assert check_permission("employee", test_store_id, "transfers", "read") is True
            db.session.commit()
        assert check_permission("employee", test_store_id, "transfers", "read") is False
        assert check_permission("employee", test_store_id, "users", "read") is True
    finally:
        reset_store_to_defaults(test_store_id, "employee")


def test_two_workers_never_leave_a_union(test_store_id):
    """Worker A holds a stale copy from before worker B's write.
    A's write must replace B's rows outright, not merge with them
    (the enforcer's row API skipped deletes memory did not know
    about)."""
    import api.Core.Permissions as P
    from api.Core.Permissions import reset_store_to_defaults, set_store_permissions
    dom = str(test_store_id)
    try:
        a, b = P._build_enforcer(), P._build_enforcer()
        P._enforcer = b
        set_store_permissions(test_store_id, "employee", {"transfers": {"read": True, "create": True}})
        P._enforcer = a  # never saw B's write
        set_store_permissions(test_store_id, "employee", {"users": {"read": True}})
        rows = _rows("employee", dom)
        assert ("users", "read") in rows
        assert ("transfers", "read") not in rows
        assert ("transfers", "create") not in rows
        assert len([r for r in rows if r[1] != "__none__"]) == 1
    finally:
        P._reset_enforcer()
        reset_store_to_defaults(test_store_id, "employee")


def test_bulk_user_write_is_one_transaction(test_store_id):
    from api.Core.Permissions import (
        clear_user_permissions, resolve_user_grants, set_user_permissions_bulk,
    )
    u1 = _mk_user(test_store_id, "bulk1@test.com")
    u2 = _mk_user(test_store_id, "bulk2@test.com")
    try:
        with db_session():
            set_user_permissions_bulk(
                test_store_id,
                {u1: {"time_clock": {"read": True}}, u2: {"time_clock": {"read": True}}},
                session=db.session,
            )
            db.session.rollback()
        assert _rows(f"user:{u1}", str(test_store_id)) == []
        assert _rows(f"user:{u2}", str(test_store_id)) == []
        set_user_permissions_bulk(
            test_store_id,
            {u1: {"time_clock": {"read": True}}, u2: {"reports": {"read": True}}},
        )
        assert resolve_user_grants(u1, "employee", test_store_id) == {("time_clock", "read")}
        assert resolve_user_grants(u2, "employee", test_store_id) == {("reports", "read")}
    finally:
        clear_user_permissions(test_store_id, u1)
        clear_user_permissions(test_store_id, u2)


# ── Finding 9: a saved role propagates atomically ──


def test_role_update_that_fails_before_commit_changes_nobody(test_store_id):
    from api.Core.Permissions import clear_user_permissions, resolve_user_grants
    from api.Modules.Admin.Services.roles import (
        assign_role, create_role, delete_role, update_role,
    )
    from api.Modules.Tenancy.Models import User
    u1 = _mk_user(test_store_id, "role1@test.com")
    u2 = _mk_user(test_store_id, "role2@test.com")
    role_id = None
    try:
        with db_session():
            role = create_role(
                db.session, test_store_id, name="Clock only",
                matrix={"time_clock": {"read": True}}, created_by=None,
            )
            for uid in (u1, u2):
                assign_role(db.session, test_store_id, db.session.get(User, uid), role.id)
            db.session.commit()
            role_id = role.id
        for uid in (u1, u2):
            assert resolve_user_grants(uid, "employee", test_store_id) == {("time_clock", "read")}

        # The request dies after the propagation, before its commit.
        with db_session():
            role, affected = update_role(
                db.session, test_store_id, role_id,
                matrix={"reports": {"read": True}},
            )
            assert {u.id for u in affected} == {u1, u2}
            db.session.rollback()
        for uid in (u1, u2):
            assert resolve_user_grants(uid, "employee", test_store_id) == {("time_clock", "read")}
        from api.Modules.Admin.Services.roles import get_role, role_matrix
        with db_session():
            assert role_matrix(get_role(db.session, test_store_id, role_id))["reports"]["read"] is False

        # A committed update lands for everyone, and is live.
        with db_session():
            update_role(db.session, test_store_id, role_id, matrix={"reports": {"read": True}})
            db.session.commit()
        for uid in (u1, u2):
            assert resolve_user_grants(uid, "employee", test_store_id) == {("reports", "read")}
    finally:
        with db_session():
            if role_id is not None:
                delete_role(db.session, test_store_id, role_id)
                db.session.commit()
        clear_user_permissions(test_store_id, u1)
        clear_user_permissions(test_store_id, u2)


def test_store_purge_drops_every_row_in_the_domain(test_store_id):
    from api.Core.Permissions import (
        purge_store_rows, set_store_permissions, set_user_permissions,
    )
    uid = _mk_user(test_store_id, "purge@test.com")
    set_store_permissions(test_store_id, "employee", {"transfers": {"read": True}})
    set_user_permissions(test_store_id, uid, {"reports": {"read": True}})
    with db_session():
        purge_store_rows(test_store_id, session=db.session)
        db.session.commit()
    assert _rows("employee", str(test_store_id)) == []
    assert _rows(f"user:{uid}", str(test_store_id)) == []
