"""DayClose: cross-store isolation, validation and audit trail.

Complements `test_day_close.py` (math + happy paths). Pins:
  * another store's departments / closes are 404 and never listed,
    and cannot be referenced from a close in this store,
  * rename collisions and department-ref errors map to 409 / 404,
  * bad dates and out-of-range bodies are 422,
  * every mutating route writes an `audit_operator_log` row and a
    rejected one writes none.
"""
import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _second_store_admin(client):
    from api.Modules.Tenancy.Models import Store, User
    with db_session():
        s = Store(name="Close B", slug="close-b", email="b@x.com",
                  plan="basic")
        db.session.add(s)
        db.session.flush()
        u = User(store_id=s.id, username="admin-cb@x.com",
                 full_name="Admin B", role="admin")
        u.set_password("testpass123!")
        db.session.add(u)
        db.session.commit()
        sid = s.id
    return sid, _h(login_admin(client, sid))


def _dept(client, h, name):
    resp = client.post("/api/v2/dayclose/departments", headers=h,
                       json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()["department"]


def _body(**kw):
    body = {"register_label": "Register 1", "gross_sales": 100.0,
            "sales_tax": 8.0, "cash_total": 50.0, "card_total": 58.0,
            "other_total": 0.0}
    body.update(kw)
    return body


def _audit_actions(store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        return [r.action for r in db.session.query(OperatorAuditLog)
                .filter_by(store_id=store_id).order_by(
                    OperatorAuditLog.id).all()]


# ── isolation ───────────────────────────────────────────────


def test_other_stores_department_and_close_are_404(client, test_store_id):
    h_a = _h(login_admin(client, test_store_id))
    dept = _dept(client, h_a, "Grocery")
    day = client.post(
        "/api/v2/dayclose/day/2026-08-20/closes", headers=h_a,
        json=_body(department_sales=[
            {"department_id": dept["id"], "amount": 60.0}]),
    ).json()
    close_id = day["closes"][0]["id"]
    _, h_b = _second_store_admin(client)

    assert client.put(
        f"/api/v2/dayclose/departments/{dept['id']}", headers=h_b,
        json={"name": "Hijack"},
    ).status_code == 404
    assert client.delete(
        f"/api/v2/dayclose/closes/{close_id}", headers=h_b,
    ).status_code == 404
    # B cannot book sales against A's department.
    assert client.post(
        "/api/v2/dayclose/day/2026-08-20/closes", headers=h_b,
        json=_body(department_sales=[
            {"department_id": dept["id"], "amount": 10.0}]),
    ).status_code == 404

    assert client.get("/api/v2/dayclose/departments?include_inactive=1",
                      headers=h_b).json()["departments"] == []
    b_day = client.get("/api/v2/dayclose/day/2026-08-20",
                       headers=h_b).json()
    assert b_day["closes"] == [] and b_day["gross_sales"] == 0

    # A's data is untouched.
    a_day = client.get("/api/v2/dayclose/day/2026-08-20",
                       headers=h_a).json()
    assert len(a_day["closes"]) == 1
    assert a_day["gross_sales"] == 100.0


def test_same_department_name_allowed_in_different_stores(
    client, test_store_id,
):
    h_a = _h(login_admin(client, test_store_id))
    _, h_b = _second_store_admin(client)
    _dept(client, h_a, "Produce")
    _dept(client, h_b, "Produce")


def test_sub_department_parent_from_other_store_is_404(client, test_store_id):
    h_a = _h(login_admin(client, test_store_id))
    parent_a = _dept(client, h_a, "Tobacco")
    _, h_b = _second_store_admin(client)
    resp = client.post("/api/v2/dayclose/departments", headers=h_b,
                       json={"name": "Cigs", "parent_id": parent_a["id"]})
    assert resp.status_code == 404


def test_requests_without_token_are_401(client):
    assert client.get("/api/v2/dayclose/departments").status_code == 401
    assert client.get("/api/v2/dayclose/day/2026-08-20").status_code == 401
    assert client.delete("/api/v2/dayclose/closes/1").status_code == 401


def test_employee_cannot_delete_close_or_rename_department(
    client, test_store_id,
):
    h_a = _h(login_admin(client, test_store_id))
    dept = _dept(client, h_a, "Deli")
    day = client.post("/api/v2/dayclose/day/2026-08-20/closes",
                      headers=h_a, json=_body()).json()
    _, emp_jwt = make_employee_client(test_store_id)
    h_e = _h(emp_jwt)
    assert client.delete(
        f"/api/v2/dayclose/closes/{day['closes'][0]['id']}", headers=h_e,
    ).status_code == 403
    assert client.put(
        f"/api/v2/dayclose/departments/{dept['id']}", headers=h_e,
        json={"name": "x"},
    ).status_code == 403
    # Nothing was removed or renamed.
    assert len(client.get("/api/v2/dayclose/day/2026-08-20",
                          headers=h_a).json()["closes"]) == 1


# ── validation ──────────────────────────────────────────────


@pytest.mark.parametrize("day", ["2026-13-01", "2026-02-30", "20260820x",
                                 "2026-8-200"])
def test_bad_day_is_422(client, test_store_id, day):
    h = _h(login_admin(client, test_store_id))
    assert client.get(f"/api/v2/dayclose/day/{day}",
                      headers=h).status_code == 422
    assert client.post(f"/api/v2/dayclose/day/{day}/closes", headers=h,
                       json=_body()).status_code == 422


@pytest.mark.parametrize("override", [
    {"register_label": ""},
    {"gross_sales": -1},
    {"cash_total": -0.01},
    {"cash_counted": -5},
    {"notes": "x" * 501},
    {"department_sales": [{"department_id": 0, "amount": 1}]},
    {"department_sales": [{"department_id": 1, "amount": -1}]},
])
def test_close_body_validation_is_422(client, test_store_id, override):
    h = _h(login_admin(client, test_store_id))
    resp = client.post("/api/v2/dayclose/day/2026-08-20/closes",
                       headers=h, json=_body(**override))
    assert resp.status_code == 422


def test_blank_register_label_is_409(client, test_store_id):
    # Passes the schema (min_length counts whitespace) but the
    # service refuses a label that is empty after stripping.
    h = _h(login_admin(client, test_store_id))
    resp = client.post("/api/v2/dayclose/day/2026-08-20/closes",
                       headers=h, json=_body(register_label="   "))
    assert resp.status_code == 409
    assert client.get("/api/v2/dayclose/day/2026-08-20",
                      headers=h).json()["closes"] == []


def test_department_validation_and_rename_conflict(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    a = _dept(client, h, "Alpha")
    b = _dept(client, h, "Beta")
    assert client.post("/api/v2/dayclose/departments", headers=h,
                       json={"name": ""}).status_code == 422
    assert client.post("/api/v2/dayclose/departments", headers=h,
                       json={"name": "x" * 81}).status_code == 422
    assert client.post("/api/v2/dayclose/departments", headers=h,
                       json={"name": "n", "sort_order": -1}
                       ).status_code == 422
    # Renaming onto another department (case-insensitive) conflicts.
    resp = client.put(f"/api/v2/dayclose/departments/{b['id']}",
                      headers=h, json={"name": "ALPHA"})
    assert resp.status_code == 409
    # Renaming to its own name is fine.
    assert client.put(f"/api/v2/dayclose/departments/{a['id']}",
                      headers=h, json={"name": "Alpha"}).status_code == 200
    assert client.put("/api/v2/dayclose/departments/999999", headers=h,
                      json={"name": "Z"}).status_code == 404


def test_deactivated_department_hidden_unless_requested(
    client, test_store_id,
):
    h = _h(login_admin(client, test_store_id))
    d = _dept(client, h, "Seasonal")
    assert client.put(f"/api/v2/dayclose/departments/{d['id']}",
                      headers=h, json={"is_active": False}
                      ).status_code == 200
    assert client.get("/api/v2/dayclose/departments",
                      headers=h).json()["departments"] == []
    assert len(client.get("/api/v2/dayclose/departments?include_inactive=1",
                          headers=h).json()["departments"]) == 1


# ── audit trail ─────────────────────────────────────────────


def test_every_mutation_is_audited(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    d = _dept(client, h, "Audited")
    client.put(f"/api/v2/dayclose/departments/{d['id']}", headers=h,
               json={"sort_order": 3})
    day = client.post("/api/v2/dayclose/day/2026-08-20/closes",
                      headers=h, json=_body()).json()
    client.delete(f"/api/v2/dayclose/closes/{day['closes'][0]['id']}",
                  headers=h)
    assert _audit_actions(test_store_id) == [
        "create_department", "update_department",
        "upsert_register_close", "delete_register_close",
    ]


def test_rejected_mutations_write_no_audit_row(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    _dept(client, h, "Once")
    before = _audit_actions(test_store_id)
    assert client.post("/api/v2/dayclose/departments", headers=h,
                       json={"name": "once"}).status_code == 409
    assert client.post("/api/v2/dayclose/day/2026-08-20/closes",
                       headers=h, json=_body(register_label=" ")
                       ).status_code == 409
    assert client.delete("/api/v2/dayclose/closes/999999",
                         headers=h).status_code == 404
    assert _audit_actions(test_store_id) == before
