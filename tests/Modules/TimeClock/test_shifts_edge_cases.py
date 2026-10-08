"""Edge cases for shift update / delete endpoints.

Complements ``test_shifts_endpoint.py`` (happy paths + store
scoping); helpers are shared from there.
"""
from tests._app import db, db_session
from tests.conftest import login_admin, login_employee
from tests.Modules.TimeClock.test_shifts_endpoint import (
    _seed_employee,
    _seed_other_store,
    _trial_store_id,
)

BASE = "/api/v2/admin/timeclock/shifts"


def _create_shift(client, headers, emp_id):
    return client.post(
        BASE,
        json={
            "store_employee_id": emp_id,
            "shift_date": "2026-05-18",
            "start_time": "09:00", "end_time": "17:00",
        },
        headers=headers,
    ).get_json()["id"]


def _admin_headers(client, store_id):
    return {"Authorization": f"Bearer {login_admin(client, store_id)}"}


def test_shift_update_reassigns_to_other_employee_and_date(client):
    with db_session():
        store_id = _trial_store_id()
        emp_a = _seed_employee(store_id, name="Shift A")
        emp_b = _seed_employee(store_id, name="Shift B")
    headers = _admin_headers(client, store_id)
    shift_id = _create_shift(client, headers, emp_a)
    resp = client.patch(
        f"{BASE}/{shift_id}",
        json={"store_employee_id": emp_b, "shift_date": "2026-05-19"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json()
    assert body["employee_name"] == "Shift B"
    assert body["shift_date"] == "2026-05-19"


def test_shift_update_rejects_employee_at_other_store(client):
    with db_session():
        store_id = _trial_store_id()
        emp = _seed_employee(store_id, name="Mine")
        foreign = _seed_employee(_seed_other_store(), name="Foreign Shift")
    headers = _admin_headers(client, store_id)
    shift_id = _create_shift(client, headers, emp)
    resp = client.patch(
        f"{BASE}/{shift_id}",
        json={"store_employee_id": foreign}, headers=headers,
    )
    assert resp.status_code == 422
    listed = client.get(
        f"{BASE}?from=2026-05-18&to=2026-05-19", headers=headers,
    ).get_json()["rows"]
    assert listed[0]["employee_name"] == "Mine"


def test_shift_update_rejects_backwards_times(client):
    with db_session():
        store_id = _trial_store_id()
        emp = _seed_employee(store_id, name="Backwards")
    headers = _admin_headers(client, store_id)
    shift_id = _create_shift(client, headers, emp)
    # Only end_time sent; merged with the stored 09:00 start it is invalid.
    resp = client.patch(
        f"{BASE}/{shift_id}", json={"end_time": "08:00"}, headers=headers,
    )
    assert resp.status_code == 422


def test_shift_update_and_delete_404_for_unknown_id(client):
    with db_session():
        store_id = _trial_store_id()
    headers = _admin_headers(client, store_id)
    assert client.patch(
        f"{BASE}/999999", json={"notes": "x"}, headers=headers,
    ).status_code == 404
    assert client.delete(f"{BASE}/999999", headers=headers).status_code == 404


def test_shift_write_routes_reject_employee_role(client):
    from api.Modules.Tenancy.Models import User
    with db_session():
        store_id = _trial_store_id()
        emp = _seed_employee(store_id, name="Guarded")
        u = User(
            store_id=store_id, username="cashier-w@test.com",
            full_name="Cashier W", role="employee",
        )
        u.set_password("testpass123!")
        db.session.add(u); db.session.commit()
    shift_id = _create_shift(client, _admin_headers(client, store_id), emp)
    token = login_employee(
        client, store_id, "cashier-w@test.com", "testpass123!",
    )
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post(BASE, json={
        "store_employee_id": emp, "shift_date": "2026-05-18",
        "start_time": "09:00", "end_time": "17:00",
    }, headers=headers).status_code == 403
    assert client.patch(
        f"{BASE}/{shift_id}", json={"notes": "x"}, headers=headers,
    ).status_code == 403
    assert client.delete(
        f"{BASE}/{shift_id}", headers=headers,
    ).status_code == 403
