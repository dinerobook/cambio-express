"""The Casbin enforcer is one in-memory copy PER PROCESS, and
production runs several gunicorn workers against one database.

The owner's report (2026-10-08): editing the built-in Employee role
on Roles & access "kept going back to the default". Cause: every
permission writer ended with ``save_policy()``, which rewrites the
whole ``casbin_rule`` table from the writing worker's memory — so a
later write on the OTHER worker (which had never loaded the first
edit) erased it. And a worker only reloaded after its own writes,
so a change made on one worker was invisible on the other until
restart.

A second worker is simulated here with a second enforcer instance
on the same engine, swapped into the module singleton.
"""
import pytest

from tests._app import db, db_session


def _mk_store_user(store_id, username):
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, role="employee",
                 is_active=True)
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()
        return u.id


# Employee: Store daily book off, MSB daily book view only.
EMPLOYEE_EDIT = {
    "daily_book": {"read": True},
    "transfers": {"read": True},
}


@pytest.fixture
def two_workers(monkeypatch):
    """Two enforcers over one DB. Yields a function that makes one
    of them the module singleton ("the worker handling this
    request"). Both start with the same, current policy."""
    import api.Core.Permissions as P
    P.reload_policy()
    workers = {"a": P._build_enforcer(), "b": P._build_enforcer()}

    def use(name):
        monkeypatch.setattr(P, "_enforcer", workers[name])
        return workers[name]
    yield use
    P._reset_enforcer()


def _employee_grants(store_id):
    from api.Core.Permissions import _reset_enforcer, _resolve_grants
    _reset_enforcer()  # a fresh process: the DB is the truth
    return _resolve_grants("employee", store_id)


def test_write_on_one_worker_survives_a_later_write_on_another(
    test_store_id, two_workers,
):
    from api.Core.Permissions import (
        clear_user_permissions, reset_store_to_defaults,
        set_store_permissions, set_user_permissions,
        user_has_custom_permissions,
    )
    uid = _mk_store_user(test_store_id, "mw_emp")
    try:
        # Worker A handles the Roles & access save.
        two_workers("a")
        set_store_permissions(test_store_id, "employee", EMPLOYEE_EDIT)
        granted = _employee_grants(test_store_id)
        assert ("day_close", "read") not in granted
        assert ("daily_book", "read") in granted

        # Worker B, which never loaded that edit, then handles an
        # unrelated permission write (assigning someone custom
        # access). The Employee-role edit must still be there.
        two_workers("b")
        set_user_permissions(
            test_store_id, uid, {"time_clock": {"read": True}},
        )
        granted = _employee_grants(test_store_id)
        assert ("day_close", "read") not in granted, (
            "worker B's save erased worker A's Employee-role edit"
        )
        assert ("daily_book", "read") in granted
        assert user_has_custom_permissions(uid, test_store_id) is True
    finally:
        clear_user_permissions(test_store_id, uid)
        reset_store_to_defaults(test_store_id, "employee")


def test_other_worker_enforces_a_write_once_its_copy_is_stale(
    test_store_id, two_workers, monkeypatch,
):
    import api.Core.Permissions as P
    from api.Core.Permissions import (
        check_permission, reset_store_to_defaults, set_store_permissions,
    )
    try:
        two_workers("a")
        set_store_permissions(test_store_id, "employee", EMPLOYEE_EDIT)

        # Worker B still holds the pre-edit policy in memory…
        two_workers("b")
        monkeypatch.setattr(P, "_RELOAD_INTERVAL", 3600.0)
        monkeypatch.setattr(P, "_loaded_at", P.time.monotonic())
        assert check_permission(
            "employee", test_store_id, "day_close", "read",
        ) is True
        # …until its copy is older than the reload window.
        monkeypatch.setattr(P, "_RELOAD_INTERVAL", 0.0)
        assert check_permission(
            "employee", test_store_id, "day_close", "read",
        ) is False
        assert check_permission(
            "employee", test_store_id, "daily_book", "read",
        ) is True
    finally:
        reset_store_to_defaults(test_store_id, "employee")


def test_writers_never_rewrite_the_whole_table(monkeypatch, test_store_id):
    """``save_policy`` is the whole-table rewrite; no writer may
    reach for it again."""
    import api.Core.Permissions as P
    from api.Core.Permissions import (
        reset_store_to_defaults, set_store_permissions,
    )
    e = P._enforcer_for_write()
    calls = []
    monkeypatch.setattr(
        e, "save_policy", lambda *a, **k: calls.append(1) or True,
    )
    set_store_permissions(test_store_id, "employee", EMPLOYEE_EDIT)
    reset_store_to_defaults(test_store_id, "employee")
    assert calls == []
