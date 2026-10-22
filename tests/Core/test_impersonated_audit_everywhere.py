"""Every store-log write made during "Sign in as" carries
"(via superadmin X)", not only the modules #969 moved.

Transfers, Batches, ReturnChecks, TVDisplay, BankSync, Customers,
Owners, the owner store switch and TimeClock used to call
``record_operator_action`` with the plain claims or the loaded user
row, so support's actions there read as the customer's own. They
now go through ``api.Core.Audit.audit_operator`` (``actor=`` for
routes that already loaded the user) or, for TimeClock's explicit
punch user, ``operator_display_name``.
"""
from pathlib import Path

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin, owner_token_for
from tests.Modules.Transfers.test_transfers_controllers import _seed_transfer
from api.Core.Clock import utc_now


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _mk_user(store_id, role="admin"):
    from api.Modules.Tenancy.Models import User
    stamp = utc_now().timestamp()
    with db_session():
        u = User(
            username=f"imp-every-{stamp}@test.com", role=role,
            full_name="Imp Every", store_id=store_id, is_active=True,
        )
        u.set_password("targetpass123!")
        db.session.add(u)
        db.session.commit()
        return u.id


def _impersonate(client, user_id, mode=None):
    sa = login_superadmin(client)
    resp = client.post(
        f"/api/v2/superadmin/impersonate/{user_id}", headers=_h(sa),
        json={"mode": mode} if mode else None,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


def _last_row(store_id, action):
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        row = (
            db.session.query(OperatorAuditLog)
              .filter_by(store_id=store_id, action=action)
              .order_by(OperatorAuditLog.id.desc())
              .first()
        )
        assert row is not None, f"no audit row for {action}"
        return row.user_id, row.user_name, row.user_role


def _count(store_id, action):
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        return db.session.query(OperatorAuditLog).filter_by(
            store_id=store_id, action=action,
        ).count()


def _delete_transfer(client, h, store_id):
    with db_session():
        tid = _seed_transfer(store_id, sender_name="Imp S",
                             recipient_name="Imp R")
    return client.delete(f"/api/v2/transfers/{tid}", headers=h)


def _create_batch(client, h, store_id):
    return client.post("/api/v2/batches", headers=h, json={
        "ach_date": "2026-01-01", "company": "Intermex",
        "batch_ref": "IMP-1", "ach_amount": 1.0,
    })


def _create_return_check(client, h, store_id):
    return client.post("/api/v2/return-checks", headers=h, json={
        "bounced_on": "2026-01-01", "customer_name": "Imp",
        "company_name": "Imp Co",
        "amount": 1.0,
    })


def _save_tv_settings(client, h, store_id):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = db.session.get(Store, store_id)
        s.plan = "basic"
        s.addons = "tv_display"
        db.session.commit()
    return client.post("/api/v2/tv-display/settings", headers=h, json={
        "title": "Rates", "subtitle": "", "orientation": "auto",
        "theme": "dark",
    })


_WRITES = [
    pytest.param(_delete_transfer, "delete", (204, 200), id="transfer"),
    pytest.param(_create_batch, "create", (201,), id="batch"),
    pytest.param(_create_return_check, "create_return_check", (201,), id="returncheck"),
    pytest.param(_save_tv_settings, "update_tv_settings", (204,), id="tv"),
]


@pytest.mark.parametrize("write, action, ok", _WRITES)
def test_impersonated_write_names_the_superadmin(
    client, test_store_id, write, action, ok,
):
    uid = _mk_user(test_store_id)
    token = _impersonate(client, uid)
    resp = write(client, _h(token), test_store_id)
    assert resp.status_code in ok, resp.text
    user_id, user_name, _ = _last_row(test_store_id, action)
    assert user_id == uid
    assert user_name.startswith("imp-every-")
    assert "(via superadmin" in user_name


@pytest.mark.parametrize("write, action, ok", _WRITES)
def test_plain_write_has_no_superadmin_suffix(
    client, test_store_id, write, action, ok,
):
    resp = write(client, _h(login_admin(client, test_store_id)),
                 test_store_id)
    assert resp.status_code in ok, resp.text
    _, user_name, _ = _last_row(test_store_id, action)
    assert user_name == "admin@test.com"


@pytest.mark.parametrize("write, action, ok", _WRITES)
def test_read_only_impersonation_writes_nothing(
    client, test_store_id, write, action, ok,
):
    uid = _mk_user(test_store_id)
    token = _impersonate(client, uid, mode="read_only")
    before = _count(test_store_id, action)
    resp = write(client, _h(token), test_store_id)
    assert resp.status_code == 403, resp.text
    assert _count(test_store_id, action) == before


class TestOwnerRoutes:
    """Owner routes already load the owner's User row and pass it as
    ``actor``: the row keeps the owner's name and role, and an
    impersonated owner session adds the superadmin mark."""

    def _owner(self, store_ids, username):
        token = owner_token_for(store_ids, username=username)
        from api.Modules.Tenancy.Models import User
        with db_session():
            oid = db.session.query(User.id).filter_by(
                username=username).scalar()
        return oid, token

    def test_owner_enter_store_plain(self, client, test_store_id):
        oid, token = self._owner([test_store_id], "own-plain@x.com")
        resp = client.post("/api/v2/auth/switch-store", headers=_h(token),
                           json={"store_id": test_store_id})
        assert resp.status_code == 200, resp.text
        user_id, user_name, role = _last_row(
            test_store_id, "owner_enter_store")
        assert (user_id, user_name, role) == (oid, "Umbrella Owner", "owner")

    def test_owner_enter_store_impersonated(self, client, test_store_id):
        oid, _ = self._owner([test_store_id], "own-imp@x.com")
        token = _impersonate(client, oid)
        resp = client.post("/api/v2/auth/switch-store", headers=_h(token),
                           json={"store_id": test_store_id})
        assert resp.status_code == 200, resp.text
        user_id, user_name, role = _last_row(
            test_store_id, "owner_enter_store")
        assert user_id == oid and role == "owner"
        assert user_name.startswith("Umbrella Owner (via superadmin")

    def test_owner_cannot_enter_a_store_outside_the_umbrella(
        self, client, test_store_id,
    ):
        from api.Modules.Tenancy.Models import Store
        with db_session():
            other = Store(name="Imp Other", slug="imp-other",
                          is_active=True)
            db.session.add(other)
            db.session.commit()
            other_id = other.id
        _, token = self._owner([test_store_id], "own-deny@x.com")
        before = _count(other_id, "owner_enter_store")
        resp = client.post("/api/v2/auth/switch-store", headers=_h(token),
                           json={"store_id": other_id})
        assert resp.status_code == 404
        assert _count(other_id, "owner_enter_store") == before


class TestAuditOperatorActor:
    def test_actor_supplies_id_name_role(self, test_store_id):
        from api.Core.Audit import audit_operator
        from api.Modules.Tenancy.Models import User
        with db_session():
            actor = User(id=987654, username="u@x.com", full_name="Full N",
                         role="owner")
            row = audit_operator(
                db.session, {"sub": "1", "role": "admin"},
                store_id=test_store_id, actor=actor,
                action="probe", target_type="store",
            )
            assert (row.user_id, row.user_name, row.user_role) == (
                987654, "Full N", "owner")
            db.session.rollback()

    def test_actor_keeps_impersonation_mark(self, test_store_id):
        from api.Core.Audit import audit_operator
        from api.Modules.Tenancy.Models import User
        with db_session():
            actor = User(id=987655, username="u2@x.com", full_name="",
                         role="owner")
            row = audit_operator(
                db.session,
                {"sub": "987655", "impersonated_by": 1,
                 "impersonator_name": "Support"},
                store_id=test_store_id, actor=actor,
                action="probe", target_type="store",
            )
            assert row.user_name == "u2@x.com (via superadmin Support)"
            db.session.rollback()


def test_no_controller_writes_operator_audit_around_the_helper():
    """Only ``api/Core/Audit.py`` calls the raw recorder, plus two
    known exceptions: TimeClock (its punch rows name an explicit
    user and use ``operator_display_name``) and the POS site agent
    (a system actor with no claims)."""
    root = Path(__file__).resolve().parents[2] / "api"
    allowed = {
        "Core/Audit.py",
        "Modules/TimeClock/Controllers/__init__.py",
        "Modules/PosImport/Services/agent.py",
        "Modules/Audit/Services/__init__.py",
        "Modules/Audit/Services/recorder.py",
    }
    offenders = []
    for path in root.rglob("*.py"):
        rel = path.relative_to(root).as_posix()
        if rel in allowed:
            continue
        if "record_operator_action(" in path.read_text():
            offenders.append(rel)
    assert offenders == [], offenders
    tc = (root / "Modules/TimeClock/Controllers/__init__.py").read_text()
    assert "user_name=operator_display_name(claims)" in tc
