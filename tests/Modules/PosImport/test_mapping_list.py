"""GET /api/v2/posimport/mapping — the store's merchandise-code →
department map (the PUT is covered in test_ingest.py).

Pinned: an admin reads back exactly what was saved, ordered by code
and named by department; another store's map never leaks in; the
day_close.update gate and the store scope refuse an employee
without the right, the superadmin (no store) and anonymous callers.
"""
from tests._app import db, db_session
from tests.conftest import (
    login_admin, login_employee, login_superadmin, make_employee_client,
)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _department(client, h, name):
    resp = client.post("/api/v2/dayclose/departments", headers=h, json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()["department"]["id"]


def _put(client, h, mapping):
    resp = client.put("/api/v2/posimport/mapping", headers=h, json={
        "mappings": [
            {"merchandise_code": code, "department_id": dept}
            for code, dept in mapping.items()
        ],
    })
    assert resp.status_code == 200, resp.text


def _other_store_admin(client):
    from api.Modules.Tenancy.Models import Store, User
    with db_session():
        s = Store(name="Other", slug="other-pos", email="o@x.test", plan="trial")
        db.session.add(s)
        db.session.flush()
        u = User(store_id=s.id, username="pos-other@test.com",
                 full_name="Other", role="admin")
        u.set_password("otherpass123!")
        db.session.add(u)
        db.session.commit()
        sid = s.id
    token = client.post("/api/v2/auth/login", json={
        "username": "pos-other@test.com", "password": "otherpass123!",
        "store_id": sid,
    }).get_json()["access_token"]
    return _h(token)


def test_an_unmapped_store_gets_an_empty_list(client, test_store_id):
    resp = client.get("/api/v2/posimport/mapping",
                      headers=_h(login_admin(client, test_store_id)))
    assert resp.status_code == 200
    assert resp.json() == {"mappings": []}


def test_admin_reads_back_the_saved_map_in_code_order(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    grocery = _department(client, h, "Grocery")
    tobacco = _department(client, h, "Tobacco")
    _put(client, h, {"4": tobacco, "17": grocery, "102": grocery})
    resp = client.get("/api/v2/posimport/mapping", headers=h)
    assert resp.status_code == 200
    assert resp.json()["mappings"] == [
        {"merchandise_code": "102", "department_id": grocery, "department_name": "Grocery"},
        {"merchandise_code": "17", "department_id": grocery, "department_name": "Grocery"},
        {"merchandise_code": "4", "department_id": tobacco, "department_name": "Tobacco"},
    ]


def test_another_stores_map_never_shows(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    _put(client, h, {"17": _department(client, h, "Grocery")})
    other = _other_store_admin(client)
    _put(client, other, {"99": _department(client, other, "Beer")})

    mine = client.get("/api/v2/posimport/mapping", headers=h).json()["mappings"]
    theirs = client.get("/api/v2/posimport/mapping", headers=other).json()["mappings"]
    assert [m["merchandise_code"] for m in mine] == ["17"]
    assert [m["merchandise_code"] for m in theirs] == ["99"]


def test_an_employee_without_day_close_update_is_refused(client, test_store_id):
    _, jwt = make_employee_client(test_store_id)
    resp = client.get("/api/v2/posimport/mapping", headers=_h(jwt))
    assert resp.status_code == 403


def test_an_employee_granted_day_close_update_may_read(client, test_store_id):
    from api.Core.Permissions import set_user_permissions
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=test_store_id, username="pos_closer", role="employee",
                 is_active=True)
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()
        uid = u.id
    set_user_permissions(test_store_id, uid,
                         {"day_close": {"read": True, "update": True}})
    token = login_employee(client, test_store_id, "pos_closer", "emppass1234")
    assert client.get("/api/v2/posimport/mapping",
                      headers=_h(token)).status_code == 200


def test_the_superadmin_has_no_store_and_is_refused(client):
    resp = client.get("/api/v2/posimport/mapping",
                      headers=_h(login_superadmin(client)))
    assert resp.status_code == 403


def test_anonymous_is_401(client):
    assert client.get("/api/v2/posimport/mapping").status_code == 401
