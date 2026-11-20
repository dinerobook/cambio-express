"""Import departments from a Modisoft "Departments" export.

The file is shaped like a real export (2026-11-19): the store's name and
two title lines, a blank line, then POS Dept | Department Name | Depart
Type | NACS Code | Tax Rate | Min Age | Items. Pins:
  * the check writes nothing and plans each row (new / update / same /
    skip), with DineroBook's type: exact for Fuel / Merchandise / Misc,
    a guess from the name for Lottery / Services, marked to confirm,
  * Modisoft's -1 (not on the register) with no items is offered
    unticked; repeated names / numbers are skipped,
  * the import takes the type the person chose, the tax rate as a
    fraction, the age limit, NACS code and register number, and a
    re-import changes nothing,
  * a department the store set up keeps its own type within the group,
  * a register number another department holds is refused (409) and
    nothing is saved,
  * only people who may edit departments can use it; one audit row.
"""
import base64

import pytest

from tests._app import db, db_session
from tests._xlsx import make_xlsx
from tests.conftest import login_admin, make_employee_client

CHECK_URL = "/api/v2/dayclose/departments/import/modisoft/check"
IMPORT_URL = "/api/v2/dayclose/departments/import/modisoft"
DEPTS_URL = "/api/v2/dayclose/departments"

HEADER = ["POS Dept", "Department Name", "Depart Type", "NACS Code",
          "Tax Rate", "Min Age", "Items"]


def _h(client, store_id):
    return {"Authorization": f"Bearer {login_admin(client, store_id)}"}


def _file(*rows):
    return make_xlsx(
        [["Corner Store"], ["Departments"], ["Departments"], [], HEADER, *rows],
        numeric_first=True,
    )


def _check(client, h, data):
    return client.post(CHECK_URL, headers=h, json={
        "content_base64": base64.b64encode(data).decode(),
    })


def _reviewed(check_rows, **types):
    """The rows a person keeps after the check, with their type picks."""
    out = []
    for r in check_rows:
        if not r["include"]:
            continue
        out.append({
            "name": r["name"], "pos_code": r["pos_code"],
            "department_type": types.get(r["name"], r["department_type"]),
            "is_taxable": r["is_taxable"], "tax_rate": r["tax_rate"],
            "min_age": r["min_age"], "nacs_code": r["nacs_code"],
        })
    return out


def _departments(client, h):
    rows = client.get(DEPTS_URL, headers=h, params={"include_inactive": 1}).json()
    return {d["name"]: d for d in rows["departments"]}


SAMPLE = (
    [7, "AUTOMOTIVE", "Merchandise", 145, 8.25, "No Restriction", 129],
    [4, "BEER", "Merchandise", 481, 8.25, 21, 1142],
    [-1, "BEVERAGES", "Merchandise", "", 0, "No Restriction", 0],
    [12, "GROCERY NON TAXABLE", "Merchandise", 400, 0, "No Restriction", 511],
    [14, "LOTTERY", "Lottery", 510, 0, 18, 1161],
    [15, "LOTTERY PAID OUT", "Lottery", 400, 0, "No Restriction", 0],
    [13, "LOTTO", "Lottery", 510, 0, 18, 0],
    [16, "LOTTO PAID OUT", "Lottery", 400, 0, "No Restriction", 0],
    [40, "MONEY ORDERS", "Services", 400, 0, "No Restriction", 0],
    [41, "MONEY ORDERS FEE", "Services", 400, 0, "No Restriction", 0],
    [42, "MONEY TRANSFER", "Services", 400, 0, "No Restriction", 0],
    [43, "MONEY TRANSFER FEE", "Services", 400, 0, "No Restriction", 0],
    [44, "DEBIT FEES", "Services", 400, 0, "No Restriction", 1],
    [-1, "Donations", "Services", "", 0, "No Restriction", 1],
    [50, "UNLEADED", "Fuel", "", 0, "No Restriction", 0],
)


def test_check_plans_every_row_and_writes_nothing(client, test_store_id):
    h = _h(client, test_store_id)
    before = _departments(client, h)
    resp = _check(client, h, _file(*SAMPLE))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    rows = {r["name"]: r for r in body["rows"]}
    assert body["columns_used"] == HEADER[:6] + ["Items"]
    assert _departments(client, h) == before  # nothing written

    beer = rows["BEER"]
    assert beer["status"] == "new" and beer["pos_code"] == "4"
    assert (beer["department_type"], beer["type_sure"]) == ("merchandise", True)
    assert (beer["is_taxable"], beer["tax_rate"]) == (True, 0.0825)
    assert (beer["min_age"], beer["nacs_code"], beer["items"]) == (21, "481", 1142)
    assert rows["AUTOMOTIVE"]["min_age"] == 0  # "No Restriction"
    assert rows["GROCERY NON TAXABLE"]["is_taxable"] is False
    assert rows["UNLEADED"]["department_type"] == "fuel"

    guesses = {
        "LOTTERY": "lottery_sell", "LOTTERY PAID OUT": "lottery_cash",
        "LOTTO": "lotto_sell", "LOTTO PAID OUT": "lotto_cash",
        "MONEY ORDERS": "money_order", "MONEY ORDERS FEE": "money_order_fee",
        "MONEY TRANSFER": "money_transfer",
        "MONEY TRANSFER FEE": "money_transfer_fee",
        "DEBIT FEES": "service", "Donations": "service",
    }
    for name, expected in guesses.items():
        assert rows[name]["department_type"] == expected, name
        assert rows[name]["type_sure"] is False, name
    assert rows["LOTTERY"]["type_group"] == "lottery"
    assert rows["DEBIT FEES"]["type_group"] == "services"

    # -1 and no items: not used in Modisoft, offered unticked.
    assert rows["BEVERAGES"]["pos_code"] is None
    assert (rows["BEVERAGES"]["unused"], rows["BEVERAGES"]["include"]) == (True, False)
    # -1 but it has an item: still offered.
    assert (rows["Donations"]["unused"], rows["Donations"]["include"]) == (False, True)


def test_import_saves_the_chosen_types_and_reimport_changes_nothing(
    client, test_store_id,
):
    from api.Modules.Audit.Models import OperatorAuditLog

    h = _h(client, test_store_id)
    rows = _check(client, h, _file(*SAMPLE)).json()["rows"]
    reviewed = _reviewed(rows, **{"DEBIT FEES": "check_cash_fee"})
    resp = client.post(IMPORT_URL, headers=h, json={"rows": reviewed})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"created": len(reviewed), "updated": 0, "unchanged": 0}

    depts = _departments(client, h)
    assert "BEVERAGES" not in depts  # unticked
    beer = depts["BEER"]
    assert beer["pos_codes"] == ["4"] and beer["department_type"] == "merchandise"
    assert (beer["is_taxable"], beer["tax_rate"]) == (True, 0.0825)
    assert (beer["min_age"], beer["nacs_code"]) == (21, "481")
    assert depts["AUTOMOTIVE"]["min_age"] is None
    assert depts["LOTTO PAID OUT"]["department_type"] == "lotto_cash"
    assert depts["DEBIT FEES"]["department_type"] == "check_cash_fee"  # the pick
    assert depts["GROCERY NON TAXABLE"]["is_taxable"] is False
    assert depts["Donations"]["pos_codes"] == []
    with db_session():
        audit = db.session.query(OperatorAuditLog).filter_by(
            store_id=test_store_id, action="import_departments",
        ).all()
    assert len(audit) == 1

    again = _check(client, h, _file(*SAMPLE)).json()["rows"]
    assert {r["status"] for r in again if r["include"]} == {"same"}
    debit = next(r for r in again if r["name"] == "DEBIT FEES")
    # The type chosen last time stays (same group as Services).
    assert (debit["department_type"], debit["type_sure"]) == ("check_cash_fee", True)
    resp = client.post(IMPORT_URL, headers=h, json={"rows": _reviewed(again)})
    assert resp.json()["created"] == 0 and resp.json()["updated"] == 0


def test_matches_by_register_number_then_name(client, test_store_id):
    h = _h(client, test_store_id)
    client.post(DEPTS_URL, headers=h, json={
        "name": "Beer & Wine", "pos_codes": ["4"], "min_age": 21,
    })
    client.post(DEPTS_URL, headers=h, json={
        "name": "lottery", "department_type": "lottery_sell", "is_taxable": False,
    })
    rows = {r["name"]: r for r in _check(client, h, _file(
        [4, "BEER", "Merchandise", 481, 8.25, 21, 10],
        [14, "LOTTERY", "Lottery", 510, 0, 18, 10],
    )).json()["rows"]}
    assert rows["BEER"]["status"] == "update"
    assert rows["BEER"]["existing_name"] == "Beer & Wine"
    assert set(rows["BEER"]["changes"]) == {"name", "tax", "nacs"}
    assert rows["LOTTERY"]["status"] == "update"
    assert set(rows["LOTTERY"]["changes"]) == {"name", "age", "nacs", "pos"}

    client.post(IMPORT_URL, headers=h, json={"rows": _reviewed(rows.values())})
    depts = _departments(client, h)
    assert "Beer & Wine" not in depts
    assert depts["BEER"]["pos_codes"] == ["4"] and depts["BEER"]["tax_rate"] == 0.0825
    assert depts["LOTTERY"]["pos_codes"] == ["14"] and depts["LOTTERY"]["min_age"] == 18


def test_a_number_held_by_another_department_is_refused(client, test_store_id):
    h = _h(client, test_store_id)
    client.post(DEPTS_URL, headers=h, json={"name": "Candy", "pos_codes": ["29"]})
    client.post(DEPTS_URL, headers=h, json={"name": "CHIPS"})
    rows = _check(client, h, _file(
        [29, "CHIPS", "Merchandise", 400, 8.25, "No Restriction", 5],
        [31, "COFFEE", "Merchandise", 400, 8.25, "No Restriction", 5],
    )).json()["rows"]
    chips = next(r for r in rows if r["name"] == "CHIPS")
    assert (chips["status"], chips["problem"], chips["problem_name"]) == (
        "skip", "pos_taken", "Candy",
    )
    assert chips["include"] is False

    forced = [{
        "name": "CHIPS", "pos_code": "29", "department_type": "merchandise",
    }, {
        "name": "COFFEE", "pos_code": "31", "department_type": "merchandise",
    }]
    resp = client.post(IMPORT_URL, headers=h, json={"rows": forced})
    assert resp.status_code == 409
    assert "Candy" in resp.json()["detail"]
    assert "COFFEE" not in _departments(client, h)  # all or nothing


def test_repeats_in_the_file_are_skipped(client, test_store_id):
    h = _h(client, test_store_id)
    rows = _check(client, h, _file(
        [8, "BEVERAGE TAXABLE", "Merchandise", 400, 8.25, "No Restriction", 5],
        [9, "beverage taxable", "Merchandise", 400, 8.25, "No Restriction", 5],
        [8, "SODA", "Merchandise", 400, 8.25, "No Restriction", 5],
    )).json()["rows"]
    assert [(r["status"], r["problem"]) for r in rows] == [
        ("new", None), ("skip", "duplicate_name"), ("skip", "duplicate_pos"),
    ]
    resp = client.post(IMPORT_URL, headers=h, json={"rows": [
        {"name": "A", "pos_code": "1", "department_type": "merchandise"},
        {"name": "a", "pos_code": "2", "department_type": "merchandise"},
    ]})
    assert resp.status_code == 409


def test_unreadable_cells_are_reported(client, test_store_id):
    h = _h(client, test_store_id)
    body = _check(client, h, _file(
        ["4-A!", "BEER", "Merchandise", "48.1x", "lots", "twenty", 1],
        [5, "", "Merchandise", 400, 0, "No Restriction", 1],
    )).json()
    issues = {i["code"]: i["lines"] for i in body["issues"]}
    assert issues == {"bad_pos": [6], "bad_nacs": [6], "bad_number": [6, 6], "no_name": [7]}
    beer = body["rows"][0]
    assert (beer["pos_code"], beer["nacs_code"], beer["is_taxable"]) == (None, None, None)


@pytest.mark.parametrize("data, needle", [
    (b"not a zip", "xlsx"),
    (make_xlsx([["Name", "Price"], ["Water", 1]]), "No header row"),
])
def test_a_file_that_is_not_a_department_export_is_refused(
    client, test_store_id, data, needle,
):
    h = _h(client, test_store_id)
    resp = _check(client, h, data)
    assert resp.status_code == 422
    assert needle in resp.json()["detail"]


def test_bad_import_values_are_refused(client, test_store_id):
    h = _h(client, test_store_id)
    for row in (
        {"name": "X", "department_type": "lottery"},
        {"name": "X", "department_type": "merchandise", "tax_rate": 1.5},
        {"name": "X", "department_type": "merchandise", "pos_code": "4 4"},
        {"name": "  ", "department_type": "merchandise"},
    ):
        resp = client.post(IMPORT_URL, headers=h, json={"rows": [row]})
        assert resp.status_code == 422, row
    resp = client.post(
        IMPORT_URL, headers={**h, "Content-Type": "application/json"},
        content='{"rows": [{"name": "X", "department_type": "merchandise", "tax_rate": NaN}]}',
    )
    assert resp.status_code == 422


def test_only_people_who_edit_departments_can_import(client, test_store_id):
    emp, etok = make_employee_client(test_store_id)
    eh = {"Authorization": f"Bearer {etok}"}
    assert _check(emp, eh, _file(*SAMPLE[:1])).status_code == 403
    resp = emp.post(IMPORT_URL, headers=eh, json={"rows": [
        {"name": "X", "department_type": "merchandise"},
    ]})
    assert resp.status_code == 403
