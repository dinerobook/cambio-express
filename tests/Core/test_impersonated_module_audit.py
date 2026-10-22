"""Writes made while a superadmin is signed in as a store user
("Sign in as") are marked "(via superadmin X)" in the store's audit
log — in every module, not only the ones that already called
``api.Core.Audit.audit_operator``.

Lottery, DayClose, Catalog, StoreBook and PosImport used to carry a
private ``_audit`` that called ``record_operator_action`` with the
plain claims, so support's writes there read as the customer's own.
They now go through ``audit_operator`` like the rest of the app.
"""

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin
from api.Core.Clock import utc_now


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _mk_admin(store_id):
    from api.Modules.Tenancy.Models import User
    stamp = utc_now().timestamp()
    with db_session():
        u = User(
            username=f"imp-audit-{stamp}@test.com", role="admin",
            full_name="Imp Target", store_id=store_id, is_active=True,
        )
        u.set_password("targetpass123!")
        db.session.add(u)
        db.session.commit()
        return u.id


def _impersonation_token(client, store_id):
    uid = _mk_admin(store_id)
    sa = login_superadmin(client)
    resp = client.post(
        f"/api/v2/superadmin/impersonate/{uid}", headers=_h(sa),
    )
    assert resp.status_code == 200, resp.text
    return uid, resp.json()["token"]


def _audit_row(store_id, action):
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        row = (
            db.session.query(OperatorAuditLog)
              .filter_by(store_id=store_id, action=action)
              .order_by(OperatorAuditLog.id.desc())
              .first()
        )
        assert row is not None, f"no audit row for {action}"
        return row.user_id, row.user_name


def _create_lottery_game(client, h):
    return client.post("/api/v2/lottery/games", headers=h, json={
        "game_number": "9001", "name": "Audit Game",
        "ticket_price": 5.0, "tickets_per_pack": 60,
    })


def _create_department(client, h):
    return client.post("/api/v2/dayclose/departments", headers=h, json={
        "name": "Audit Dept", "sort_order": 0,
    })


def _create_vendor(client, h):
    return client.post("/api/v2/catalog/vendors", headers=h, json={
        "name": "Audit Vendor",
    })


def _patch_storebook(client, h):
    return client.patch("/api/v2/storebook/2026-08-02", headers=h, json={
        "values": {"money_order": 1_000},
    })


_WRITES = [
    pytest.param(_create_lottery_game, "create_lottery_game", 201,
                 id="lottery"),
    pytest.param(_create_department, "create_department", 201,
                 id="dayclose"),
    pytest.param(_create_vendor, "create_vendor", 201, id="catalog"),
    pytest.param(_patch_storebook, "update", 200, id="storebook"),
]


@pytest.mark.parametrize("write, action, status", _WRITES)
def test_impersonated_write_names_the_superadmin(
    client, test_store_id, write, action, status,
):
    uid, token = _impersonation_token(client, test_store_id)
    resp = write(client, _h(token))
    assert resp.status_code == status, resp.text
    user_id, user_name = _audit_row(test_store_id, action)
    # Attributed to the customer's login, marked as support.
    assert user_id == uid
    assert user_name.startswith("imp-audit-")
    assert "(via superadmin" in user_name


@pytest.mark.parametrize("write, action, status", _WRITES)
def test_plain_write_has_no_superadmin_suffix(
    client, test_store_id, write, action, status,
):
    resp = write(client, _h(login_admin(client, test_store_id)))
    assert resp.status_code == status, resp.text
    _, user_name = _audit_row(test_store_id, action)
    assert user_name == "admin@test.com"
    assert "superadmin" not in user_name


def test_refused_write_records_nothing(client, test_store_id):
    """A write the module refuses (here: a duplicate game number,
    409) leaves no audit row behind."""
    from api.Modules.Audit.Models import OperatorAuditLog
    h = _h(login_admin(client, test_store_id))
    assert _create_lottery_game(client, h).status_code == 201
    with db_session():
        before = db.session.query(OperatorAuditLog).filter_by(
            store_id=test_store_id, action="create_lottery_game",
        ).count()
    assert _create_lottery_game(client, h).status_code == 409
    with db_session():
        after = db.session.query(OperatorAuditLog).filter_by(
            store_id=test_store_id, action="create_lottery_game",
        ).count()
    assert after == before


class TestSuperadminAuditHelpers:
    """FeatureFlags + Announcements now write through
    ``audit_superadmin``: same row shape as before."""

    def test_feature_flag_create_is_audited(self, client):
        from api.Modules.Audit.Models import SuperadminAuditLog
        sa = login_superadmin(client)
        resp = client.post(
            "/api/v2/feature-flags", headers=_h(sa),
            json={"key": "audit_probe_flag", "label": "Probe",
                  "enabled_by_default": True},
        )
        assert resp.status_code in (200, 201), resp.text
        with db_session():
            row = (
                db.session.query(SuperadminAuditLog)
                  .filter_by(action="create_feature_flag")
                  .order_by(SuperadminAuditLog.id.desc()).first()
            )
            assert row is not None
            assert row.target_type == "feature_flag"
            assert row.target_id == "audit_probe_flag"
            assert row.admin_name

    def test_feature_flag_create_refused_for_store_admin(
        self, client, test_store_id,
    ):
        resp = client.post(
            "/api/v2/feature-flags",
            headers=_h(login_admin(client, test_store_id)),
            json={"key": "audit_probe_denied", "label": "No",
                  "enabled_by_default": True},
        )
        assert resp.status_code == 403

    def test_announcement_create_is_audited(self, client):
        from api.Modules.Audit.Models import SuperadminAuditLog
        sa = login_superadmin(client)
        resp = client.post(
            "/api/v2/announcements", headers=_h(sa),
            json={"message": "Audit probe", "level": "info"},
        )
        assert resp.status_code in (200, 201), resp.text
        with db_session():
            row = (
                db.session.query(SuperadminAuditLog)
                  .filter_by(action="create_announcement")
                  .order_by(SuperadminAuditLog.id.desc()).first()
            )
            assert row is not None
            assert row.target_type == "announcement"
            assert row.admin_name
