"""A department's own tax rate (Account → Departments, owner 2026-11-20).

Ticking "Taxable" on the department form shows a "Tax rate (%)" box,
empty by default. The rate travels as a fraction (0.0825 = 8.25 %), like
the store's sales tax rate. Pins:
  * the rate round-trips on create and update,
  * no rate is fine (the box starts empty),
  * a department that is not taxable never keeps a rate — on create,
    and when taxable is turned off later,
  * ``tax_rate: 0`` clears it, an omitted rate leaves it,
  * a rate outside 0–100 % is refused (422),
  * the migration's column matches the model and imports no
    application code.
"""
import ast
import pathlib

from tests.conftest import login_admin

URL = "/api/v2/dayclose/departments"

_MIGRATION = (
    pathlib.Path(__file__).resolve().parents[3]
    / "alembic" / "versions" / "c2f7a4e9b1d6_add_department_tax_rate.py"
)


def _h(client, store_id):
    return {"Authorization": f"Bearer {login_admin(client, store_id)}"}


def _create(client, h, **body):
    body.setdefault("name", "Grocery")
    resp = client.post(URL, headers=h, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["department"]


def _update(client, h, dept_id, **body):
    resp = client.put(f"{URL}/{dept_id}", headers=h, json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["department"]


def test_rate_round_trips(client, test_store_id):
    h = _h(client, test_store_id)
    dept = _create(client, h, name="Grocery", is_taxable=True, tax_rate=0.0825)
    assert dept["tax_rate"] == 0.0825
    listed = client.get(URL, headers=h).json()["departments"]
    assert [d["tax_rate"] for d in listed if d["id"] == dept["id"]] == [0.0825]
    dept = _update(client, h, dept["id"], tax_rate=0.07)
    assert dept["tax_rate"] == 0.07


def test_no_rate_is_allowed(client, test_store_id):
    h = _h(client, test_store_id)
    dept = _create(client, h, name="Snacks", is_taxable=True)
    assert dept["is_taxable"] is True
    assert dept["tax_rate"] is None


def test_a_department_that_is_not_taxable_keeps_no_rate(client, test_store_id):
    h = _h(client, test_store_id)
    dept = _create(client, h, name="Lottery", is_taxable=False, tax_rate=0.05)
    assert dept["tax_rate"] is None

    dept = _create(client, h, name="Beer", is_taxable=True, tax_rate=0.09)
    dept = _update(client, h, dept["id"], is_taxable=False)
    assert dept["is_taxable"] is False
    assert dept["tax_rate"] is None


def test_zero_clears_and_omitted_leaves_the_rate(client, test_store_id):
    h = _h(client, test_store_id)
    dept = _create(client, h, name="Deli", is_taxable=True, tax_rate=0.06)
    dept = _update(client, h, dept["id"], name="Deli counter")
    assert dept["tax_rate"] == 0.06
    dept = _update(client, h, dept["id"], tax_rate=0)
    assert dept["tax_rate"] is None


def test_a_rate_outside_zero_to_hundred_percent_is_refused(client, test_store_id):
    h = _h(client, test_store_id)
    for bad in (1.5, -0.01):
        resp = client.post(URL, headers=h, json={
            "name": f"Bad {bad}", "is_taxable": True, "tax_rate": bad,
        })
        assert resp.status_code == 422, resp.text
    dept = _create(client, h, name="Tobacco", is_taxable=True)
    resp = client.put(f"{URL}/{dept['id']}", headers=h, json={"tax_rate": 2})
    assert resp.status_code == 422, resp.text


def test_migration_column_matches_the_model():
    import importlib.util
    from api.Modules.DayClose.Models import Department

    spec = importlib.util.spec_from_file_location("dept_tax_migration", _MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    column = Department.__table__.columns["tax_rate"]
    assert module.ADDED_COLUMNS == ("tax_rate",)
    assert column.nullable is True


def test_migration_imports_no_application_code():
    tree = ast.parse(_MIGRATION.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            assert not (node.module or "").startswith("api"), node.module
        if isinstance(node, ast.Import):
            assert not any(a.name.startswith("api") for a in node.names)
