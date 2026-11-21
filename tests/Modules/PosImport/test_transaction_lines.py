"""The Transactions page's Items view: every line sold
(``GET /posimport/transaction-lines``).

Synthetic fixtures only — never real Gilbarco journal data. The rules
under test:

* only tickets that count are listed (sales and refunds, never a void
  ticket, a no-sale or a superseded prepay deposit), and a voided line
  is never summed — it has its own "voided" view;
* Passport's ActualSalesPrice is the line's amount, so the unit sold at
  is amount / quantity and "below regular" compares against
  regular × quantity;
* cost and margin come from the store's price book, and only where it
  holds a cost.
"""
from datetime import date, datetime

import pytest

from api.Modules.Catalog.Models import PriceBookItem
from api.Modules.DayClose.Models import Department
from api.Modules.PosImport.Models import (
    PosMerchandiseMap, PosTransaction, PosTransactionLine,
)
from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client

DAY = date(2025, 12, 8)
URL = "/api/v2/posimport/transaction-lines"


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


def _admin(client, store_id):
    return _headers(login_admin(client, store_id))


def _ticket(store_id, *, no, kind="sale", hour=12, superseded=False, lines=()):
    txn = PosTransaction(
        store_id=store_id, business_date=DAY, source_file=f"PJR-{no}.xml",
        kind=kind, register_id="1", cashier_id="91", till_id="7",
        transaction_no=no, event_sequence_id="1",
        started_at=datetime(2025, 12, 8, hour, 0, 0),
        ended_at=datetime(2025, 12, 8, hour, 0, 5),
        # Never shown: the event's own end time is (owner, 2026-11-20).
        receipt_at=datetime(2025, 12, 8, hour, 59, 59),
        superseded=superseded,
    )
    db.session.add(txn)
    db.session.flush()
    for seq, spec in enumerate(lines, 1):
        db.session.add(PosTransactionLine(
            transaction_id=txn.id, store_id=store_id, business_date=DAY,
            line_seq=seq, status=spec.get("status", "normal"),
            pos_code=spec.get("pos_code", ""),
            description=spec["description"],
            merchandise_code=spec.get("merch", "10"),
            quantity=spec.get("qty", 1.0),
            amount_cents=spec.get("amount", 0),
            actual_price_cents=spec.get("amount", 0),
            regular_price_cents=spec.get("regular", 0),
            is_fuel=spec.get("fuel", False),
            gallons=spec.get("gallons", 0.0),
        ))
    db.session.flush()
    return txn.id


@pytest.fixture()
def day(client, test_store_id):
    with db_session():
        dept = Department(store_id=test_store_id, name="Beverages")
        db.session.add(dept)
        db.session.flush()
        db.session.add(PosMerchandiseMap(
            store_id=test_store_id, merchandise_code="10", department_id=dept.id,
        ))
        db.session.add(PriceBookItem(
            store_id=test_store_id, pos_code="611269001303", name="Red Bull",
            price_cents=399, cost_cents=250,
        ))
        _ticket(test_store_id, no="100", hour=9, lines=[
            # Two for $6 against $3.99 each: sold below regular.
            {"pos_code": "611269001303", "description": "RED BULL", "qty": 2,
             "amount": 600, "regular": 399},
            # Two tacos at shelf price: ActualSalesPrice is the line's $6.98.
            {"pos_code": "28", "description": "BREAKFAST TACOS", "qty": 2,
             "amount": 698, "regular": 349, "merch": "28"},
        ])
        _ticket(test_store_id, no="101", hour=10, lines=[
            {"description": "NOVELTY", "amount": 600, "merch": "40"},
            {"pos_code": "111", "description": "VOIDED CHIPS", "status": "cancel",
             "amount": 0, "regular": 199},
        ])
        _ticket(test_store_id, no="102", hour=11, lines=[
            {"description": "UNLEAD PLS", "fuel": True, "amount": 3000,
             "qty": 10.0, "gallons": 10.0, "merch": "1"},
        ])
        # Never listed: a whole voided ticket, a superseded deposit.
        _ticket(test_store_id, no="103", kind="void", hour=12, lines=[
            {"pos_code": "222", "description": "VOID TICKET ITEM", "amount": 999},
        ])
        _ticket(test_store_id, no="104", hour=13, superseded=True, lines=[
            {"description": "PREPAY DEPOSIT", "fuel": True, "amount": 2000},
        ])
        db.session.commit()


def _get(client, headers, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return client.get(
        f"{URL}?start={DAY.isoformat()}&end={DAY.isoformat()}"
        + (f"&{query}" if query else ""),
        headers=headers,
    )


def test_lists_only_lines_that_sold_on_tickets_that_count(client, test_store_id, day):
    resp = _get(client, _admin(client, test_store_id))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [r["description"] for r in body["rows"]] == [
        "UNLEAD PLS", "NOVELTY", "BREAKFAST TACOS", "RED BULL",
    ]
    assert body["total"] == 4
    # $6.00 + $6.98 + $6.00 + $30.00 — never the void ticket, the
    # superseded deposit or the voided chips.
    assert body["total_amount"] == pytest.approx(48.98)
    # 2 + 2 + 1 units; the 10 gallons of fuel apart.
    assert body["total_quantity"] == pytest.approx(5.0)
    assert body["total_gallons"] == pytest.approx(10.0)


def test_unit_price_is_amount_over_quantity(client, test_store_id, day):
    rows = {r["description"]: r for r in _get(client, _admin(client, test_store_id)).json()["rows"]}
    tacos = rows["BREAKFAST TACOS"]
    assert (tacos["unit_price"], tacos["regular_price"], tacos["below_regular"]) == (3.49, 3.49, False)
    bull = rows["RED BULL"]
    assert (bull["unit_price"], bull["regular_price"], bull["below_regular"]) == (3.0, 3.99, True)
    assert rows["RED BULL"]["department_name"] == "Beverages"
    assert rows["BREAKFAST TACOS"]["department_name"] == ""


def test_below_regular_view(client, test_store_id, day):
    body = _get(client, _admin(client, test_store_id), show="below_regular").json()
    assert [r["description"] for r in body["rows"]] == ["RED BULL"]


def test_department_key_view_leaves_scanned_items_and_fuel_out(
    client, test_store_id, day,
):
    body = _get(client, _admin(client, test_store_id), show="department_key").json()
    assert [r["description"] for r in body["rows"]] == ["NOVELTY"]


def test_voided_view_lists_cancelled_lines_at_their_price(client, test_store_id, day):
    body = _get(client, _admin(client, test_store_id), show="voided").json()
    assert [r["description"] for r in body["rows"]] == ["VOIDED CHIPS"]
    row = body["rows"][0]
    assert (row["status"], row["amount"], row["unit_price"]) == ("cancel", 0.0, 1.99)
    assert row["cost"] is None


def test_cost_and_margin_come_from_the_price_book(client, test_store_id, day):
    body = _get(client, _admin(client, test_store_id)).json()
    rows = {r["description"]: r for r in body["rows"]}
    # $2.50 cost × 2 against $6.00: $1.00 profit, 16.67 %.
    assert rows["RED BULL"]["cost"] == pytest.approx(5.0)
    assert rows["RED BULL"]["margin_pct"] == pytest.approx(16.67)
    assert rows["BREAKFAST TACOS"]["cost"] is None
    assert rows["BREAKFAST TACOS"]["margin_pct"] is None
    assert body["total_cost"] == pytest.approx(5.0)
    assert body["costed_amount"] == pytest.approx(6.0)


def test_department_filter_and_its_choices(client, test_store_id, day):
    h = _admin(client, test_store_id)
    body = _get(client, h, department="10").json()
    assert {r["description"] for r in body["rows"]} == {"RED BULL"}
    assert body["departments"] == [{"code": "10", "name": "Beverages"}]


def test_search_matches_description_or_scan_code(client, test_store_id, day):
    h = _admin(client, test_store_id)
    assert [r["description"] for r in _get(client, h, q="taco").json()["rows"]] == ["BREAKFAST TACOS"]
    assert [r["description"] for r in _get(client, h, q="6112690").json()["rows"]] == ["RED BULL"]


def test_sort_by_amount(client, test_store_id, day):
    rows = _get(client, _admin(client, test_store_id), sort="amount", dir="asc").json()["rows"]
    assert [r["amount"] for r in rows] == [6.0, 6.0, 6.98, 30.0]


def test_times_leave_as_utc_in_the_stores_zone(client, test_store_id, day):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        db.session.get(Store, test_store_id).timezone = "America/Chicago"
        db.session.commit()
    rows = _get(client, _admin(client, test_store_id), q="taco").json()["rows"]
    assert rows[0]["at"] == "2025-12-08T15:00:05"


@pytest.mark.parametrize("params", [
    {"show": "lottery"},
    {"start": "2025-12-09"},
    {"start": "2025-01-01"},
    {"dir": "sideways"},
])
def test_bad_queries_are_refused(client, test_store_id, params):
    query = {"start": DAY.isoformat(), "end": DAY.isoformat(), **params}
    resp = client.get(
        URL + "?" + "&".join(f"{k}={v}" for k, v in query.items()),
        headers=_admin(client, test_store_id),
    )
    assert resp.status_code == 422


def test_another_stores_lines_never_show(client, test_store_id, day):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other", slug="other-lines", email="o@x.test",
                      plan="pro", is_active=True)
        db.session.add(other)
        db.session.flush()
        _ticket(other.id, no="900", lines=[
            {"pos_code": "999", "description": "NOT YOURS", "amount": 100},
        ])
        db.session.commit()
    rows = _get(client, _admin(client, test_store_id)).json()["rows"]
    assert "NOT YOURS" not in {r["description"] for r in rows}


def test_a_cashier_with_read_access_sees_the_items(client, test_store_id, day):
    emp_client, token = make_employee_client(test_store_id)
    assert _get(emp_client, _headers(token)).status_code == 200


def test_without_day_close_read_the_items_are_refused(client, test_store_id, day):
    emp_client, token = make_employee_client(test_store_id, permissions={
        "day_close": {"create": False, "read": False, "update": False, "delete": False},
    })
    assert _get(emp_client, _headers(token)).status_code == 403


def test_anonymous_is_rejected(client):
    assert _get(client, {}).status_code == 401
