"""DELETE /transfers/{id} and the PUT validation paths that the
happy-path update tests don't reach."""
import pytest

from api.Modules.Audit.Models import OperatorAuditLog, TransferAudit
from api.Modules.Tenancy.Models import Store
from api.Modules.Transfers.Models import Transfer
from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin, make_employee_client
from tests.Modules.Transfers.test_transfers_controllers import (
    _seed_employee, _seed_transfer,
)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _put_body(emp_id, **over):
    body = {
        "send_date": "2026-02-10", "company": "Intermex",
        "service_type": "Money Transfer", "sender_name": "Edit Sender",
        "send_amount": 200.0, "fee": 4.0, "country": "Mexico",
        "recipient_name": "Edit Recipient", "employee_id": emp_id,
    }
    body.update(over)
    return body


def _foreign_transfer():
    other = Store(name="Xfer Other", slug="xfer-other", is_active=True)
    db.session.add(other)
    db.session.commit()
    return _seed_transfer(other.id, sender_name="Foreign", recipient_name="F2")


# ── DELETE ──────────────────────────────────────────────────────

def test_delete_removes_transfer_history_and_audits(client, test_store_id, test_admin_id):
    with db_session():
        tid = _seed_transfer(test_store_id, sender_name="Gone Sender",
                             recipient_name="Gone Recipient",
                             send_amount=120.0, confirm_number="CONF-DEL")
        db.session.add(TransferAudit(
            store_id=test_store_id, transfer_id=tid, user_id=test_admin_id,
            action="created",
        ))
        db.session.commit()
    token = login_admin(client, test_store_id)
    resp = client.delete(f"/api/v2/transfers/{tid}", headers=_h(token))
    assert resp.status_code == 204
    with db_session():
        assert db.session.get(Transfer, tid) is None
        assert db.session.query(TransferAudit).filter_by(transfer_id=tid).count() == 0
        log = db.session.query(OperatorAuditLog).filter_by(
            action="delete", target_type="transfer",
            store_id=test_store_id).one()
        # Survives the row it describes, with enough to identify it.
        assert log.target_id == str(tid)
        assert "Gone Sender" in log.target_label and "120.00" in log.target_label
        assert "confirm=CONF-DEL" in log.summary
    # Deleting twice is a plain 404, not a 500.
    assert client.delete(f"/api/v2/transfers/{tid}", headers=_h(token)).status_code == 404


def test_delete_other_stores_transfer_is_404_and_keeps_row(client, test_store_id):
    with db_session():
        foreign = _foreign_transfer()
    token = login_admin(client, test_store_id)
    assert client.delete(f"/api/v2/transfers/{foreign}",
                         headers=_h(token)).status_code == 404
    with db_session():
        assert db.session.get(Transfer, foreign) is not None
        assert db.session.query(OperatorAuditLog).filter_by(action="delete").count() == 0


def test_delete_requires_auth_and_permission(client, test_store_id):
    with db_session():
        tid = _seed_transfer(test_store_id)
    assert client.delete(f"/api/v2/transfers/{tid}").status_code == 401
    _, emp_jwt = make_employee_client(test_store_id)
    assert client.delete(f"/api/v2/transfers/{tid}",
                         headers=_h(emp_jwt)).status_code == 403
    sa = login_superadmin(client)
    assert client.delete(f"/api/v2/transfers/{tid}",
                         headers=_h(sa)).status_code in (403, 404)
    with db_session():
        assert db.session.get(Transfer, tid) is not None


# ── PUT validation ──────────────────────────────────────────────

def test_update_rejects_bad_send_date_and_keeps_row(client, test_store_id):
    with db_session():
        emp = _seed_employee(test_store_id)
        tid = _seed_transfer(test_store_id, sender_name="Orig")
    token = login_admin(client, test_store_id)
    resp = client.put(f"/api/v2/transfers/{tid}",
                      json=_put_body(emp, send_date="02/10/2026"),
                      headers=_h(token))
    assert resp.status_code == 422
    with db_session():
        assert db.session.get(Transfer, tid).sender_name == "Orig"


def test_update_with_unknown_cashier_is_422(client, test_store_id):
    """An employee_id outside the store's roster must not be accepted."""
    with db_session():
        tid = _seed_transfer(test_store_id, sender_name="Orig")
    token = login_admin(client, test_store_id)
    resp = client.put(f"/api/v2/transfers/{tid}",
                      json=_put_body(987654), headers=_h(token))
    assert resp.status_code == 422
    with db_session():
        assert db.session.get(Transfer, tid).sender_name == "Orig"


def test_update_keeps_money_invariant(client, test_store_id):
    with db_session():
        emp = _seed_employee(test_store_id)
        tid = _seed_transfer(test_store_id)
    token = login_admin(client, test_store_id)
    resp = client.put(f"/api/v2/transfers/{tid}",
                      json=_put_body(emp, send_amount=300.0, fee=6.0),
                      headers=_h(token))
    assert resp.status_code == 200
    with db_session():
        t = db.session.get(Transfer, tid)
        assert t.total_collected == pytest.approx(
            t.send_amount + t.fee + t.federal_tax)
        assert t.federal_tax > 0


def test_update_rejects_storeless_superadmin(client, test_store_id):
    with db_session():
        emp = _seed_employee(test_store_id)
        tid = _seed_transfer(test_store_id)
    sa = login_superadmin(client)
    resp = client.put(f"/api/v2/transfers/{tid}", json=_put_body(emp),
                      headers=_h(sa))
    assert resp.status_code == 403
