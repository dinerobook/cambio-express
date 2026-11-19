"""Department setup fields (Account → Departments).

The owner sets up departments the way Modisoft does: the register's
department number, the kind of sales (type), taxable, minimum buyer age
and the NACS product code. Pins:
  * the fields round-trip on create / update, with safe defaults,
  * a register number ("POS dept no") is the register-import mapping
    itself (``retail_pos_merchandise_map``) — one place, no copy,
  * a number already held by another department is refused (409) and
    nothing changes; another STORE may use the same number,
  * ``pos_codes`` replaces the list, ``[]`` clears it, omitted leaves it,
  * ``min_age: 0`` clears the age limit,
  * bad types / numbers are 422,
  * employees can read but not change the setup,
  * the migration's literal column list matches the model and imports
    no application code; the request's type list matches the model's.
"""
import ast
import pathlib
import typing

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client

URL = "/api/v2/dayclose/departments"


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _admin(client, store_id):
    return _h(login_admin(client, store_id))


def _create(client, h, **body):
    body.setdefault("name", "Grocery")
    resp = client.post(URL, headers=h, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["department"]


def _mapped(store_id):
    from api.Modules.PosImport.Models import PosMerchandiseMap
    with db_session():
        return sorted(
            (m.merchandise_code, m.department_id)
            for m in db.session.query(PosMerchandiseMap).filter_by(store_id=store_id)
        )


def test_setup_fields_round_trip(client, test_store_id):
    h = _admin(client, test_store_id)
    dept = _create(
        client, h, name="LOTTERY", department_type="lottery_sell",
        is_taxable=False, min_age=18, nacs_code="510", pos_codes=["14"],
    )
    assert dept["department_type"] == "lottery_sell"
    assert dept["is_taxable"] is False
    assert dept["min_age"] == 18
    assert dept["nacs_code"] == "510"
    assert dept["pos_codes"] == ["14"]
    # The number IS the register-import mapping, not a copy of it.
    assert _mapped(test_store_id) == [("14", dept["id"])]

    listed = client.get(URL, headers=h).json()["departments"]
    assert [d["pos_codes"] for d in listed] == [["14"]]


def test_defaults_for_a_plain_department(client, test_store_id):
    h = _admin(client, test_store_id)
    dept = _create(client, h, name="Snacks")
    assert dept["department_type"] == "merchandise"
    assert dept["is_taxable"] is True
    assert dept["min_age"] is None
    assert dept["nacs_code"] == ""
    assert dept["pos_codes"] == []


def test_a_number_held_by_another_department_is_refused(client, test_store_id):
    h = _admin(client, test_store_id)
    beer = _create(client, h, name="BEER", pos_codes=["4"])
    resp = client.post(URL, headers=h, json={"name": "WINE", "pos_codes": ["5", "4"]})
    assert resp.status_code == 409
    assert "4" in resp.json()["detail"] and "BEER" in resp.json()["detail"]
    # Nothing was created or moved.
    assert [d["name"] for d in client.get(URL, headers=h).json()["departments"]] == ["BEER"]
    assert _mapped(test_store_id) == [("4", beer["id"])]

    wine = _create(client, h, name="WINE", pos_codes=["5"])
    resp = client.put(f"{URL}/{wine['id']}", headers=h, json={"pos_codes": ["4"]})
    assert resp.status_code == 409
    assert _mapped(test_store_id) == sorted([("4", beer["id"]), ("5", wine["id"])])


def test_pos_codes_replace_clear_and_leave(client, test_store_id):
    h = _admin(client, test_store_id)
    dept = _create(client, h, name="CIGARETTE", pos_codes=["6"])

    resp = client.put(f"{URL}/{dept['id']}", headers=h, json={"pos_codes": ["27", "6", "6"]})
    assert resp.status_code == 200, resp.text
    # De-duplicated, numeric order.
    assert resp.json()["department"]["pos_codes"] == ["6", "27"]

    # Omitted: unchanged.
    resp = client.put(f"{URL}/{dept['id']}", headers=h, json={"nacs_code": "411"})
    assert resp.json()["department"]["pos_codes"] == ["6", "27"]
    assert resp.json()["department"]["nacs_code"] == "411"

    # Empty list: cleared.
    resp = client.put(f"{URL}/{dept['id']}", headers=h, json={"pos_codes": []})
    assert resp.json()["department"]["pos_codes"] == []
    assert _mapped(test_store_id) == []


def test_min_age_zero_clears_and_type_updates(client, test_store_id):
    h = _admin(client, test_store_id)
    dept = _create(client, h, name="BEER", min_age=21)
    resp = client.put(f"{URL}/{dept['id']}", headers=h, json={
        "min_age": 0, "department_type": "misc", "is_taxable": False,
    })
    body = resp.json()["department"]
    assert body["min_age"] is None
    assert body["department_type"] == "misc"
    assert body["is_taxable"] is False


def test_bad_values_are_422(client, test_store_id):
    h = _admin(client, test_store_id)
    for body in (
        {"name": "X", "department_type": "groceries"},
        {"name": "X", "pos_codes": ["4 5"]},
        {"name": "X", "pos_codes": ["-1"]},
        {"name": "X", "min_age": 150},
        {"name": "X", "nacs_code": "40-0"},
    ):
        assert client.post(URL, headers=h, json=body).status_code == 422, body


def test_another_store_may_use_the_same_number(client, test_store_id):
    from api.Modules.Tenancy.Models import Store, User
    h = _admin(client, test_store_id)
    _create(client, h, name="BEER", pos_codes=["4"])
    with db_session():
        s = Store(name="Dept B", slug="dept-setup-b", email="db@x.com", plan="basic")
        db.session.add(s)
        db.session.flush()
        u = User(store_id=s.id, username="admin-dsb@x.com", full_name="Admin B", role="admin")
        u.set_password("testpass123!")
        db.session.add(u)
        db.session.commit()
        other = s.id
    hb = _admin(client, other)
    _create(client, hb, name="BEER", pos_codes=["4"])
    assert [c for c, _ in _mapped(other)] == ["4"]


def test_employee_reads_but_cannot_change_setup(client, test_store_id):
    h = _admin(client, test_store_id)
    dept = _create(client, h, name="DELI")
    _emp, jwt = make_employee_client(test_store_id, username_suffix="deptsetup")
    eh = _h(jwt)
    assert client.get(URL, headers=eh).status_code == 200
    assert client.post(URL, headers=eh, json={"name": "Y"}).status_code == 403
    assert client.put(
        f"{URL}/{dept['id']}", headers=eh, json={"pos_codes": ["19"]},
    ).status_code == 403
    assert _mapped(test_store_id) == []


# ── Contracts that keep the copies in step ─────────────────


_MIGRATION = (
    pathlib.Path(__file__).resolve().parents[3]
    / "alembic" / "versions" / "b3e7c1a9d5f2_department_setup_fields.py"
)


def test_migration_columns_match_the_model():
    import importlib.util
    from api.Modules.DayClose.Models import Department

    spec = importlib.util.spec_from_file_location("dept_setup_migration", _MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model_cols = {c.name for c in Department.__table__.columns}
    for name in module.ADDED_COLUMNS:
        assert name in model_cols, name
    assert set(module.ADDED_COLUMNS) == {
        "department_type", "is_taxable", "min_age", "nacs_code",
    }


def test_migration_imports_no_application_code():
    tree = ast.parse(_MIGRATION.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            assert not (node.module or "").startswith("api"), node.module
        if isinstance(node, ast.Import):
            assert not any(a.name.startswith("api") for a in node.names)


def test_request_type_list_matches_the_model():
    from api.Modules.DayClose.Models import DEPARTMENT_TYPES
    from api.Modules.DayClose.Requests import DepartmentType
    assert tuple(typing.get_args(DepartmentType)) == DEPARTMENT_TYPES
