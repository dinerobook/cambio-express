"""The read-only movement day view (G-7): GET /posimport/movement.

Under test:

  * fuel per grade adds sales over positions and tiers, but reads each
    pump meter once per position — tiers never multiply it, and with
    two reports in a day the later reading wins,
  * MSM rows come back in file order with subtotal / part roles, and
    the subtotal equals its parts (summing both would double),
  * departments, tax levels, item totals and the file list,
  * only business-day reports are summarised (a shift report never
    double counts), every file is still listed,
  * admin only (same as the staged list); a bad day is a 422.
"""
import pytest

from tests.Modules.PosImport.movement_fixtures import (
    ALL_FAMILIES, fgm, fgm_detail, fgm_tier, mcm, movement_doc, msm,
)
from tests.Modules.PosImport.test_agent import (
    _admin, _agent_upload, _headers, _issue_key,
)
from tests.conftest import make_employee_client


@pytest.fixture
def admin(client, test_store_id):
    return _admin(client, test_store_id)


@pytest.fixture
def agent_key(client, admin):
    return _issue_key(client, admin)["key"]


def _day(client, h, day="2025-12-05"):
    resp = client.get(f"/api/v2/posimport/movement?day={day}", headers=h)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_a_full_day(client, admin, agent_key):
    for family, build in ALL_FAMILIES.items():
        _agent_upload(client, agent_key, f"{family}1.xml", build())
    body = _day(client, admin)

    assert body["day"] == "2025-12-05"
    assert [(f["family"], f["filename"], f["parse_error"]) for f in body["files"]] == [
        ("FGM", "FGM1.xml", ""), ("ISM", "ISM1.xml", ""), ("MCM", "MCM1.xml", ""),
        ("MSM", "MSM1.xml", ""), ("TLM", "TLM1.xml", ""), ("TPM", "TPM1.xml", ""),
    ]
    assert all(f["received_at"] for f in body["files"])

    g1, g2 = body["fuel"]
    assert g1["grade_id"] == "001"
    assert g1["gallons"] == pytest.approx(12.345 + 20.5 + 5.25 + 1.0)
    assert g1["amount"] == pytest.approx(40.12 + 61.75 + 15.75 + 2.5)
    # Two positions, two tiers each: each meter counted ONCE.
    assert g1["positions"] == 2
    assert g1["meter_gallons"] == pytest.approx(41250.25 + 1000.10)
    assert g1["meter_amount"] == pytest.approx(98760.40 + 2500.20)
    assert g2 == {
        "grade_id": "002", "gallons": 10.5, "amount": 35.12,
        "meter_gallons": 500.5, "meter_amount": 1500.75, "positions": 1,
    }

    assert body["departments"] == [
        {"merchandise_code": "10", "description": "SODA", "quantity": 4.0,
         "amount": 8.46, "refunds": 0.0, "transactions": 3},
        {"merchandise_code": "1024", "description": "LOTTERY",
         "quantity": 2.0, "amount": 20.0, "refunds": -5.0, "transactions": 1},
    ]
    assert body["tax_levels"] == [
        {"tax_level_id": "101", "taxable_sales": 200.0, "tax_collected": 16.5,
         "tax_exempt_sales": 0.0, "tax_forgiven_sales": 0.0},
        {"tax_level_id": "99", "taxable_sales": 1520.33,
         "tax_collected": 125.43, "tax_exempt_sales": 0.0,
         "tax_forgiven_sales": 3.1},
    ]
    assert body["item_rows"] == 3
    assert body["item_quantity"] == 10.0
    assert body["item_amount"] == pytest.approx(7.47 + 0.99 + 2.10)


def test_msm_subtotal_and_parts_never_add_up_twice(client, admin, agent_key):
    _agent_upload(client, agent_key, "MSM1.xml", msm())
    misc = _day(client, admin)["misc"]
    roles = [(m["code"], m["sub_code"], m["modifier"], m["role"]) for m in misc]
    assert roles == [
        ("safeDrop", "total", None, ""),
        ("payouts", "total", None, ""),
        ("payouts", "vendorPay", None, "subtotal"),
        ("payouts", "vendorPay", "3", "part"),
        ("payouts", "vendorPay", "3", "part"),
        ("payouts", "vendorPay", "3", "part"),
        # Leaves with no subtotal stay plain rows, even repeated ones.
        ("totalizer", "sales", "mdseOnly", ""),
        ("totalizer", "sales", "mdseOnly", ""),
        ("fuelSalesByGrade", "fuel", "1", ""),
    ]
    payouts = [m for m in misc if m["code"] == "payouts"]
    total = next(m["amount"] for m in payouts if m["sub_code"] == "total")
    subtotal = next(m["amount"] for m in payouts if m["role"] == "subtotal")
    parts = sum(m["amount"] for m in payouts if m["role"] == "part")
    # payouts/total = vendorPay subtotal = its parts…
    assert total == subtotal == pytest.approx(parts) == pytest.approx(-150.0)
    # …and adding the subtotal AND its parts is the "2x" BACKLOG G-7
    # asked about.
    assert subtotal + parts == pytest.approx(2 * total)
    assert misc[0]["tender_code"] == "cash"
    assert misc[0]["count"] == 4.0


def test_the_later_report_holds_the_meter(client, admin, agent_key):
    early = movement_doc("FGM", fgm_detail("001", "1", "100", "300", [
        fgm_tier("0001", "5", "15"), fgm_tier("0002", "5", "16"),
    ]), begin_time="06:00:00", end_date="2025-12-05", end_time="14:00:00")
    late = movement_doc("FGM", fgm_detail("001", "1", "110", "331", [
        fgm_tier("0001", "10", "31"),
    ]), begin_time="14:00:01", end_date="2025-12-05", end_time="22:00:00")
    _agent_upload(client, agent_key, "FGM-late.xml", late)
    _agent_upload(client, agent_key, "FGM-early.xml", early)
    [grade] = _day(client, admin)["fuel"]
    assert grade["gallons"] == 20.0
    assert grade["amount"] == pytest.approx(62.0)
    assert grade["positions"] == 1
    assert grade["meter_gallons"] == 110.0
    assert grade["meter_amount"] == 331.0


def test_only_day_reports_are_summarised(client, admin, agent_key):
    _agent_upload(client, agent_key, "MCM-day.xml", mcm())
    _agent_upload(client, agent_key, "MCM-shift.xml", mcm(primary_period="1"))
    _agent_upload(client, agent_key, "FGM-shift.xml", fgm(primary_period="1"))
    body = _day(client, admin)
    assert [f["filename"] for f in body["files"]] == [
        "FGM-shift.xml", "MCM-day.xml", "MCM-shift.xml",
    ]
    assert [d["amount"] for d in body["departments"]] == [8.46, 20.0]
    assert body["fuel"] == []


def test_an_unreadable_file_is_listed_with_its_error(client, admin, agent_key):
    bad = mcm().replace("<SalesAmount>8.46</SalesAmount>",
                        "<SalesAmount>x</SalesAmount>")
    _agent_upload(client, agent_key, "MCM-bad.xml", bad)
    body = _day(client, admin)
    [f] = body["files"]
    assert f["family"] == "MCM"
    assert "Bad money value" in f["parse_error"]
    assert body["departments"] == []


def test_an_empty_day(client, admin):
    assert _day(client, admin, "2025-01-01") == {
        "day": "2025-01-01", "files": [], "fuel": [], "departments": [],
        "tax_levels": [], "misc": [], "item_rows": 0, "item_quantity": 0.0,
        "item_amount": 0.0,
    }


def test_a_bad_day_is_refused(client, admin):
    resp = client.get("/api/v2/posimport/movement?day=12/05/2025", headers=admin)
    assert resp.status_code == 422


def test_employees_cannot_read_it(client, test_store_id):
    _emp_client, jwt = make_employee_client(test_store_id)
    resp = client.get(
        "/api/v2/posimport/movement?day=2025-12-05", headers=_headers(jwt),
    )
    assert resp.status_code == 403
