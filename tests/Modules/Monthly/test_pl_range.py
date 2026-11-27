"""The P&L for any date range (owner 2026-11-27: Period P&L merged
into the Monthly P&L) — Services/range.py, Monthly INVARIANTS "Any
date range".

* a range of whole months reads exactly like those months' pages;
* a month the range cuts counts what has a day (daily books, bank
  rows by day, returned checks, money order charges) and leaves its
  typed lines out, reported in `left_out`;
* money transfer fees are never income;
* validation, access, store scope.
"""
from datetime import date, datetime

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client
from tests.Modules.Monthly.test_transactions_ledger import (
    _account, _bank, _entry, _flags, _h, _msb_day,
)

URL = "/api/v2/monthly/range"


def _admin(client, sid):
    return _h(login_admin(client, sid))


def _range(client, sid, d_from, d_to, headers=None):
    return client.get(
        URL, query_string={"from": d_from, "to": d_to},
        headers=headers or _admin(client, sid),
    )


def _month(client, sid, y, m):
    return client.get(
        f"/api/v2/monthly/{y}/{m}", headers=_admin(client, sid),
    ).get_json()["report"]


def _seed(sid):
    from api.Modules.Monthly.Models import MonthlyFinancial
    _msb_day(sid, date(2026, 10, 5), taxable_sales=500.0, cash_expense=20.0)
    _msb_day(sid, date(2026, 11, 3), taxable_sales=300.0)
    _msb_day(sid, date(2026, 11, 20), taxable_sales=700.0)
    _entry(sid, date(2026, 11, 4), "cash_expense", 40.0, "ice")
    with db_session():
        db.session.add(MonthlyFinancial(
            store_id=sid, year=2026, month=11, money_order_rent=150.0,
        ))
        db.session.add(MonthlyFinancial(
            store_id=sid, year=2026, month=10, accounting_charges=80.0,
        ))
        db.session.commit()


def test_whole_months_read_like_their_pages(client, test_store_id):
    sid = test_store_id
    _seed(sid)
    one = _range(client, sid, "2026-11-01", "2026-11-30").get_json()
    page = _month(client, sid, 2026, 11)
    for key in ("taxable_sales", "cash_expenses", "money_order_rent",
                "total_income", "total_expenses", "net_profit", "days_entered"):
        assert one["report"][key] == page[key], key
    assert one["whole_months"] == 1 and one["left_out"] == []
    two = _range(client, sid, "2026-10-01", "2026-11-30").get_json()["report"]
    oct_ = _month(client, sid, 2026, 10)
    assert two["taxable_sales"] == oct_["taxable_sales"] + page["taxable_sales"]
    assert two["net_profit"] == round(oct_["net_profit"] + page["net_profit"], 2)
    assert two["accounting_charges"] == 80.0


def test_a_cut_month_counts_its_days_and_leaves_typed_lines_out(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _seed(sid)
    _bank(sid, acct, -4500, datetime(2026, 11, 7, 10), "pl_credit_card_fees")
    _bank(sid, acct, -1000, datetime(2026, 11, 25, 10), "pl_credit_card_fees")
    body = _range(client, sid, "2026-10-15", "2026-11-10").get_json()
    r = body["report"]
    assert r["taxable_sales"] == 300.0          # Nov 3 only
    assert r["cash_expenses"] == 40.0           # the Nov 4 entry
    assert r["credit_card_fees"] == 45.0        # the Nov 7 bank row
    assert r["money_order_rent"] == 0.0 and r["accounting_charges"] == 0.0
    assert r["days_entered"] == 2               # Nov 3, Nov 4
    # The entry moves the Nov 4 drawer, so over/short is income too.
    assert r["total_income"] == round(300.0 + r["over_short"], 2)
    assert r["total_expenses"] == 85.0
    assert body["whole_months"] == 0
    assert {(x["line"], x["amount"], x["month"]) for x in body["left_out"]} == {
        ("money_order_rent", 150.0, 11), ("accounting_charges", 80.0, 10),
    }
    assert "credit_card_fees" in r["bank_locked"]
    assert "taxable_sales" in r["daily_fed"]


def test_returned_checks_count_by_their_days(client, test_store_id):
    from api.Modules.ReturnChecks.Models import ReturnCheck, ReturnCheckPayment
    sid = test_store_id
    _msb_day(sid, date(2026, 11, 2), taxable_sales=10.0)
    with db_session():
        rc = ReturnCheck(store_id=sid, customer_name="C", amount_cents=10000,
                         return_check_fee_cents=2500, bounced_on=date(2026, 11, 1))
        db.session.add(rc)
        db.session.flush()
        db.session.add(ReturnCheckPayment(return_check_id=rc.id, amount_cents=12500,
                                          paid_on=date(2026, 11, 12)))
        db.session.commit()
    early = _range(client, sid, "2026-11-01", "2026-11-10").get_json()["report"]
    late = _range(client, sid, "2026-11-11", "2026-11-20").get_json()["report"]
    assert early["return_check_gl"] == 0.0
    assert late["return_check_gl"] == -25.0     # the fee is a gain


def test_money_transfer_fees_are_never_income(client, test_store_id, test_admin_id):
    from api.Modules.Transfers.Models import Transfer
    sid = test_store_id
    _msb_day(sid, date(2026, 11, 3), taxable_sales=100.0)
    with db_session():
        db.session.add(Transfer(
            store_id=sid, send_date=date(2026, 11, 3), sender_name="S",
            recipient_name="R", country="MX", confirm_number="RANGE1",
            company="Intermex", send_amount=200.0, fee=10.0, federal_tax=2.0,
            status="sent",
        ))
        db.session.commit()
    r = _range(client, sid, "2026-11-02", "2026-11-04").get_json()["report"]
    assert r["total_income"] == 100.0


def test_a_store_category_and_a_moved_entry_count_in_a_cut_month(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _msb_day(sid, date(2026, 11, 1), taxable_sales=10.0)
    cat = client.post(
        "/api/v2/monthly/categories/custom",
        json={"name": "Ice", "section": "expense"}, headers=_admin(client, sid),
    ).get_json()["category"]
    _bank(sid, acct, -2500, datetime(2026, 11, 5, 10), cat["slug"])
    e = _entry(sid, date(2026, 11, 6), "cash_expense", 15.0, "CPA")
    client.put(f"/api/v2/monthly/entries/{e}/category",
               json={"slug": cat["slug"]}, headers=_admin(client, sid))
    r = _range(client, sid, "2026-11-04", "2026-11-08").get_json()["report"]
    assert r["custom_lines"] == [{
        "id": cat["id"], "slug": cat["slug"], "name": "Ice",
        "section": "expense", "amount": 40.0,
    }]
    assert r["cash_expenses"] == 0.0 and r["total_expenses"] == 40.0


def test_an_empty_range_reads_zero(client, test_store_id):
    body = _range(client, test_store_id, "2026-01-01", "2026-01-31").get_json()
    assert body["report"]["total_income"] == 0.0 and body["whole_months"] == 0


def test_bad_ranges(client, test_store_id):
    sid = test_store_id
    assert _range(client, sid, "2026-11-10", "2026-11-01").status_code == 422
    assert _range(client, sid, "2020-01-01", "2026-01-01").status_code == 422
    assert _range(client, sid, "2026-13-01", "2026-11-01").status_code == 422
    assert client.get(URL, headers=_admin(client, sid)).status_code == 422


def test_needs_monthly_read(test_store_id):
    sid = test_store_id
    c, jwt = make_employee_client(sid, username_suffix="rangeno", permissions={
        "monthly": {"read": False},
    })
    assert _range(c, sid, "2026-11-01", "2026-11-30", headers=_h(jwt)).status_code == 403
    c, jwt = make_employee_client(sid, username_suffix="rangeyes", permissions={
        "monthly": {"read": True},
    })
    assert _range(c, sid, "2026-11-01", "2026-11-30", headers=_h(jwt)).status_code == 200


def test_only_this_stores_money(client, test_store_id):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other range", slug="other-range", plan="trial")
        db.session.add(other)
        db.session.commit()
        other_id = other.id
    _msb_day(other_id, date(2026, 11, 3), taxable_sales=999.0)
    r = _range(client, test_store_id, "2026-11-01", "2026-11-30").get_json()["report"]
    assert r["taxable_sales"] == 0.0
