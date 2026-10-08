"""Admin controller routes that had no HTTP coverage: owner connect-code
redemption, team/employee 404 + validation paths, matrix-mode store
permissions, coming-soon add-ons, and the paid-plan subscription
summary."""
from datetime import timedelta

import pytest

from api.Core.Clock import utc_now
from api.Modules.Audit.Models import OperatorAuditLog
from api.Modules.Tenancy.Models import (
    OwnerConnectCode, Store, StoreEmployee, StoreOwnerLink, User,
)
from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _paid(store_id, plan="basic"):
    with db_session():
        db.session.get(Store, store_id).plan = plan
        db.session.commit()


# ── POST /admin/redeem-connect-code ─────────────────────────────

def _mk_owner(username="gap_owner"):
    with db_session():
        o = User(store_id=None, username=username, role="owner",
                 full_name="Olivia Owner", is_active=True)
        o.set_password("ownerpass123")
        db.session.add(o)
        db.session.commit()
        return o.id


def _mk_code(owner_id, code="ABCD1234", **over):
    fields = dict(owner_id=owner_id, code=code,
                  expires_at=utc_now() + timedelta(days=7))
    fields.update(over)
    with db_session():
        db.session.add(OwnerConnectCode(**fields))
        db.session.commit()


def _redeem(client, token, code):
    return client.post("/api/v2/admin/redeem-connect-code",
                       headers=_h(token), json={"code": code})


def test_redeem_connect_code_links_store_and_audits(client, test_store_id):
    owner_id = _mk_owner()
    _mk_code(owner_id)
    token = login_admin(client, test_store_id)
    # Lower-case + padding must still match (codes are upper-case).
    resp = _redeem(client, token, "  abcd1234 ")
    assert resp.status_code == 200
    assert resp.get_json() == {"owner_name": "Olivia Owner"}
    with db_session():
        assert db.session.query(StoreOwnerLink).filter_by(
            owner_id=owner_id, store_id=test_store_id).count() == 1
        occ = db.session.query(OwnerConnectCode).filter_by(
            code="ABCD1234").one()
        assert occ.used_at is not None
        assert occ.used_by_store_id == test_store_id
        log = db.session.query(OperatorAuditLog).filter_by(
            action="redeem_owner_connect_code", store_id=test_store_id).one()
        assert "ABCD1234" in log.summary
    # Single use: a second redemption is refused and adds no link.
    again = _redeem(client, token, "ABCD1234")
    assert again.status_code == 422
    assert "already been redeemed" in again.get_json()["detail"]


@pytest.mark.parametrize("code,over,status,fragment", [
    ("", None, 422, "required"),
    ("NOPE0000", None, 404, "not found"),
    ("REVOKED1", {"revoked_at": utc_now()}, 422, "revoked"),
    ("EXPIRED1", {"expires_at": utc_now() - timedelta(days=1)}, 422, "expired"),
])
def test_redeem_connect_code_rejections(client, test_store_id,
                                        code, over, status, fragment):
    owner_id = _mk_owner()
    if over is not None:
        _mk_code(owner_id, code=code, **over)
    token = login_admin(client, test_store_id)
    resp = _redeem(client, token, code)
    assert resp.status_code == status
    assert fragment in resp.get_json()["detail"].lower()
    with db_session():
        assert db.session.query(StoreOwnerLink).count() == 0


def test_redeem_connect_code_409_when_already_linked(client, test_store_id):
    owner_id = _mk_owner()
    _mk_code(owner_id)
    with db_session():
        db.session.add(StoreOwnerLink(owner_id=owner_id, store_id=test_store_id))
        db.session.commit()
    token = login_admin(client, test_store_id)
    assert _redeem(client, token, "ABCD1234").status_code == 409
    with db_session():
        assert db.session.query(OwnerConnectCode).one().used_at is None


def test_redeem_connect_code_denied_for_employee(client, test_store_id):
    owner_id = _mk_owner()
    _mk_code(owner_id)
    _, jwt = make_employee_client(test_store_id)
    assert _redeem(client, jwt, "ABCD1234").status_code == 403
    with db_session():
        assert db.session.query(StoreOwnerLink).count() == 0


# ── Team roster + employees hub: 404 / validation ───────────────

def test_team_member_blank_rename_and_missing_ids(client, test_store_id):
    token = login_admin(client, test_store_id)
    made = client.post("/api/v2/admin/team", headers=_h(token),
                       json={"name": "Gap Member"})
    assert made.status_code == 201
    mid = made.get_json()["id"]

    blank = client.put(f"/api/v2/admin/team/{mid}", headers=_h(token),
                       json={"name": "   "})
    assert blank.status_code == 422
    with db_session():
        assert db.session.get(StoreEmployee, mid).name == "Gap Member"

    assert client.put("/api/v2/admin/team/99999", headers=_h(token),
                      json={"name": "x"}).status_code == 404
    assert client.delete("/api/v2/admin/team/99999",
                         headers=_h(token)).status_code == 404


def test_team_and_employee_rows_of_other_store_are_404(client, test_store_id):
    with db_session():
        other = Store(name="Gap Other", slug="gap-other", is_active=True)
        db.session.add(other)
        db.session.commit()
        foreign = StoreEmployee(store_id=other.id, name="Foreign Emp")
        db.session.add(foreign)
        db.session.commit()
        fid = foreign.id
    token = login_admin(client, test_store_id)
    assert client.delete(f"/api/v2/admin/team/{fid}",
                         headers=_h(token)).status_code == 404
    assert client.patch(f"/api/v2/admin/employees/{fid}", headers=_h(token),
                        json={"name": "Hijack"}).status_code == 404
    assert client.post(f"/api/v2/admin/employees/{fid}/link",
                       headers=_h(token), json={"user_id": 1}).status_code == 404
    assert client.delete(f"/api/v2/admin/employees/{fid}/link",
                         headers=_h(token)).status_code == 404
    with db_session():
        assert db.session.get(StoreEmployee, fid).name == "Foreign Emp"
        assert db.session.get(StoreEmployee, fid).is_active


def test_create_employee_with_unknown_login_is_422(client, test_store_id):
    token = login_admin(client, test_store_id)
    resp = client.post("/api/v2/admin/employees", headers=_h(token),
                       json={"name": "Gap Linked", "user_id": 987654})
    assert resp.status_code == 422


def test_update_employee_blank_name_is_422_and_unaudited(client, test_store_id):
    token = login_admin(client, test_store_id)
    emp_id = client.post("/api/v2/admin/employees", headers=_h(token),
                         json={"name": "Gap Person"}).get_json()["id"]
    resp = client.patch(f"/api/v2/admin/employees/{emp_id}",
                        headers=_h(token), json={"name": " "})
    assert resp.status_code == 422
    with db_session():
        assert db.session.get(StoreEmployee, emp_id).name == "Gap Person"
        assert db.session.query(OperatorAuditLog).filter_by(
            action="update_employee").count() == 0


def test_empty_store_info_update_writes_no_audit_row(client, test_store_id):
    """An empty PUT changes nothing and must not write an audit row."""
    token = login_admin(client, test_store_id)
    resp = client.put("/api/v2/admin/store-info", headers=_h(token), json={})
    assert resp.status_code == 200
    with db_session():
        assert db.session.query(OperatorAuditLog).filter_by(
            action="update_store_info").count() == 0


# ── Users: saved-role assignment on create ──────────────────────

def test_create_user_with_unknown_role_is_404(client, test_store_id):
    token = login_admin(client, test_store_id)
    resp = client.post("/api/v2/admin/users", headers=_h(token), json={
        "email": "gap.newhire@example.com", "password": "Passw0rd!long",
        "full_name": "New Hire", "role": "employee", "store_role_id": 424242,
    })
    assert resp.status_code == 404


# ── Store permissions: matrix mode + reset ──────────────────────

def test_store_permissions_matrix_mode_and_reset(client, test_store_id):
    token = login_admin(client, test_store_id)
    current = client.get("/api/v2/admin/store-permissions",
                         headers=_h(token)).get_json()
    matrix = {"employee": current["matrix"]["employee"]}
    matrix["employee"]["settings"]["delete"] = True
    put = client.put("/api/v2/admin/store-permissions", headers=_h(token),
                     json={"matrix": matrix})
    assert put.status_code == 200
    assert put.get_json()["matrix"]["employee"]["settings"]["delete"] is True
    with db_session():
        assert db.session.query(OperatorAuditLog).filter_by(
            action="update_store_permissions").count() == 1

    reset = client.post("/api/v2/admin/store-permissions/reset",
                        headers=_h(token), json={"role": "employee"})
    assert reset.status_code == 200
    assert reset.get_json()["matrix"]["employee"]["settings"]["delete"] is False


def test_store_permissions_matrix_for_non_editable_role_is_403(client, test_store_id):
    token = login_admin(client, test_store_id)
    current = client.get("/api/v2/admin/store-permissions",
                         headers=_h(token)).get_json()
    resp = client.put("/api/v2/admin/store-permissions", headers=_h(token),
                      json={"matrix": {"admin": current["matrix"]["employee"]}})
    assert resp.status_code == 403
    assert client.post("/api/v2/admin/store-permissions/reset",
                       headers=_h(token),
                       json={"role": "admin"}).status_code == 403


# ── Add-ons + subscription summary ──────────────────────────────

def test_toggle_coming_soon_addon_is_409(client, test_store_id, monkeypatch):
    from api.Modules.Billing.Services import ADDONS_CATALOG
    monkeypatch.setitem(ADDONS_CATALOG, "gap_future",
                        {"name": "Future Thing", "status": "coming_soon"})
    _paid(test_store_id)
    token = login_admin(client, test_store_id)
    resp = client.post("/api/v2/admin/addons/gap_future/toggle",
                       headers=_h(token))
    assert resp.status_code == 409
    assert "coming soon" in resp.get_json()["detail"]
    with db_session():
        assert "gap_future" not in (db.session.get(Store, test_store_id).addons or "")


def test_subscription_summary_for_paid_store_mints_referral_code(client, test_store_id):
    _paid(test_store_id, "pro")
    token = login_admin(client, test_store_id)
    body = client.get("/api/v2/admin/subscription", headers=_h(token)).get_json()
    assert body["has_paid_plan"] is True
    assert body["trial_status"] is None and body["trial_days_left"] is None
    assert body["referral_code"]
    assert body["cancel_at_period_end"] is False
    # The code shown must be the one persisted (regression: the mint was
    # flushed but never committed, so every load showed a new code).
    from api.Modules.Billing.Models import ReferralCode
    with db_session():
        stored = db.session.query(ReferralCode).filter_by(
            owner_store_id=test_store_id).all()
        assert [r.code for r in stored] == [body["referral_code"]]
    info = client.get("/api/v2/admin/store-info", headers=_h(token)).get_json()
    assert info["referral_code"] == body["referral_code"]


def test_subscription_summary_for_trial_store_reports_countdown(client, test_store_id):
    token = login_admin(client, test_store_id)
    body = client.get("/api/v2/admin/subscription", headers=_h(token)).get_json()
    assert body["has_paid_plan"] is False
    assert body["trial_status"] in {"active", "expiring_soon"}
    assert 0 <= body["trial_days_left"] <= 7
    assert body["referral_code"] is None
