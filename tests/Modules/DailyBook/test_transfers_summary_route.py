"""Route-level tests for GET /api/v2/daily/{store_id}/{date}/transfers-summary.

The service is covered in test_transfers_summary.py; these pin the
HTTP contract the Daily Book's Money Transfers tab relies on: the
numbers on the wire, and that the store scope + daily_book.read
gate hold (another store's admin, the superadmin, and an employee
without the right all get 403).
"""
from datetime import date, timedelta

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee, login_superadmin

DAY = date.today() - timedelta(days=2)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _url(sid, d=DAY):
    return f"/api/v2/daily/{sid}/{d.isoformat()}/transfers-summary"


def _seed(store_id):
    from api.Modules.Transfers.Models import Transfer
    base = dict(store_id=store_id, send_date=DAY, service_type="Money Transfer",
                sender_name="Ana", commission=0.0, status="Sent")
    with db_session():
        db.session.add_all([
            Transfer(**{**base, "company": "Intermex", "send_amount": 100.0,
                        "fee": 5.0, "federal_tax": 1.0, "commission": 2.0}),
            Transfer(**{**base, "company": "Intermex", "send_amount": 50.0,
                        "fee": 3.0, "federal_tax": 0.5}),
            Transfer(**{**base, "company": "Maxi", "send_amount": 200.0,
                        "fee": 10.0, "federal_tax": 2.0}),
            # Cancelled: never counts.
            Transfer(**{**base, "company": "Maxi", "send_amount": 999.0,
                        "fee": 9.0, "federal_tax": 9.0, "status": "Cancelled"}),
            # Another day: never counts.
            Transfer(**{**base, "company": "Maxi", "send_amount": 777.0,
                        "fee": 7.0, "federal_tax": 7.0,
                        "send_date": DAY - timedelta(days=1)}),
        ])
        db.session.commit()


def _other_store_admin(client):
    from api.Modules.Tenancy.Models import Store, User
    with db_session():
        s = Store(name="Other", slug="other-store", email="o@x.test", plan="trial")
        db.session.add(s)
        db.session.flush()
        u = User(store_id=s.id, username="other-admin@test.com",
                 full_name="Other Admin", role="admin")
        u.set_password("otherpass123!")
        db.session.add(u)
        db.session.commit()
        sid = s.id
    token = client.post("/api/v2/auth/login", json={
        "username": "other-admin@test.com", "password": "otherpass123!",
        "store_id": sid,
    }).get_json()["access_token"]
    return sid, _h(token)


def _employee(client, store_id, username, matrix):
    from api.Core.Permissions import set_user_permissions
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, role="employee",
                 is_active=True)
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()
        uid = u.id
    set_user_permissions(store_id, uid, matrix)
    return _h(login_employee(client, store_id, username, "emppass1234"))


def test_admin_gets_the_day_rolled_up_by_company(client, test_store_id):
    _seed(test_store_id)
    resp = client.get(_url(test_store_id),
                      headers=_h(login_admin(client, test_store_id)))
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json()
    assert body["companies"] == ["Intermex", "Maxi", "Barri"]
    by = {r["company"]: r for r in body["by_company"]}
    assert by["Intermex"]["count"] == 2
    assert by["Intermex"]["amount"] == pytest.approx(150.0)
    assert by["Intermex"]["fees"] == pytest.approx(8.0)
    assert by["Intermex"]["federal_tax"] == pytest.approx(1.5)
    assert by["Intermex"]["commission"] == pytest.approx(2.0)
    assert by["Intermex"]["total"] == pytest.approx(161.5)
    assert by["Maxi"]["count"] == 1
    assert by["Maxi"]["total"] == pytest.approx(212.0)
    assert by["Barri"]["count"] == 0
    assert body["grand_total"] == pytest.approx(373.5)


def test_an_empty_day_still_lists_every_company(client, test_store_id):
    resp = client.get(_url(test_store_id, date.today() - timedelta(days=30)),
                      headers=_h(login_admin(client, test_store_id)))
    assert resp.status_code == 200
    body = resp.get_json()
    assert [r["company"] for r in body["by_company"]] == ["Intermex", "Maxi", "Barri"]
    assert body["grand_total"] == 0


def test_an_employee_with_daily_book_read_may_read_it(client, test_store_id):
    _seed(test_store_id)
    reader = _employee(client, test_store_id, "ts_reader",
                       {"daily_book": {"read": True}})
    resp = client.get(_url(test_store_id), headers=reader)
    assert resp.status_code == 200
    assert resp.get_json()["grand_total"] == pytest.approx(373.5)


def test_an_employee_without_daily_book_read_is_refused(client, test_store_id):
    _seed(test_store_id)
    no_book = _employee(client, test_store_id, "ts_nobook",
                        {"transfers": {"read": True}})
    resp = client.get(_url(test_store_id), headers=no_book)
    assert resp.status_code == 403
    assert "amount" not in resp.get_data(as_text=True)


def test_another_stores_admin_is_refused(client, test_store_id):
    _seed(test_store_id)
    _, other = _other_store_admin(client)
    resp = client.get(_url(test_store_id), headers=other)
    assert resp.status_code == 403


def test_the_superadmin_is_refused(client, test_store_id):
    resp = client.get(_url(test_store_id), headers=_h(login_superadmin(client)))
    assert resp.status_code == 403


def test_no_token_is_401(client, test_store_id):
    assert client.get(_url(test_store_id)).status_code == 401


def test_a_malformed_date_is_rejected(client, test_store_id):
    resp = client.get(f"/api/v2/daily/{test_store_id}/2026-13-40/transfers-summary",
                      headers=_h(login_admin(client, test_store_id)))
    assert resp.status_code in (400, 422)
