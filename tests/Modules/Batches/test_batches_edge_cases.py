"""Batch routes: duplicate-ref rejection on edit and store-scope guards."""
from api.Modules.Batches.Models import ACHBatch
from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin
from tests.Modules.Batches.test_batches_controllers import _seed_batch


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _write_body(**over):
    body = {
        "ach_date": "2026-03-01", "company": "Intermex",
        "batch_ref": "B-EDIT", "ach_amount": 100.0,
    }
    body.update(over)
    return body


def test_update_to_existing_ref_is_422_and_leaves_batch_unchanged(client, test_store_id):
    with db_session():
        _seed_batch(test_store_id, batch_ref="B-TAKEN")
        mine_id = _seed_batch(test_store_id, batch_ref="B-MINE", ach_amount=50.0)
    token = login_admin(client, test_store_id)
    resp = client.put(f"/api/v2/batches/{mine_id}", headers=_h(token),
                      json=_write_body(batch_ref="B-TAKEN", ach_amount=999.0))
    assert resp.status_code == 422
    assert resp.get_json()["detail"]["field"] == "batch_ref"
    with db_session():
        row = db.session.get(ACHBatch, mine_id)
        assert row.batch_ref == "B-MINE" and float(row.ach_amount) == 50.0


def test_update_keeping_own_ref_is_allowed(client, test_store_id):
    with db_session():
        mine_id = _seed_batch(test_store_id, batch_ref="B-SAME")
    token = login_admin(client, test_store_id)
    resp = client.put(f"/api/v2/batches/{mine_id}", headers=_h(token),
                      json=_write_body(batch_ref="B-SAME", ach_amount=75.0))
    assert resp.status_code == 200
    assert resp.get_json()["batch"]["ach_amount"] == 75.0


def test_storeless_superadmin_cannot_read_or_list_batch_transfers(client):
    sa = login_superadmin(client)
    assert client.get("/api/v2/batches/1", headers=_h(sa)).status_code == 403
    assert client.get("/api/v2/batches/1/transfers",
                      headers=_h(sa)).status_code == 403
