"""Monthly P&L fed live from the daily books.

The reported bug: the P&L stayed empty for a month full of daily
book entries until someone opened Edit and pressed Save, and even
then it went stale on the next daily edit. These tests pin the fix
(INVARIANTS.md "Daily feed"):

* one day in either daily book is enough for the month to read;
* every figure is live — a day entered after a save shows without a
  re-save, and the GET never writes;
* a line the daily books have a figure for reads it (read-only,
  listed in `daily_fed`); a line they are silent on keeps what was
  typed; the bank feed still wins over both;
* a saved month with no daily entries keeps its saved figures;
* access and store isolation are unchanged.
"""
from datetime import date, datetime

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client


Y, M = 2026, 10


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _get(client, store_id, year=Y, month=M):
    return client.get(
        f"/api/v2/monthly/{year}/{month}",
        headers=_h(login_admin(client, store_id)),
    )


def _put(client, store_id, body, year=Y, month=M):
    return client.put(
        f"/api/v2/monthly/{year}/{month}", json=body,
        headers=_h(login_admin(client, store_id)),
    )


def _msb_day(store_id, d, **fields):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        db.session.add(DailyReport(store_id=store_id, report_date=d, **fields))
        db.session.commit()


def _store_day(store_id, d, **fields):
    from api.Modules.StoreBook.Models import StoreDailyEntry
    with db_session():
        db.session.add(StoreDailyEntry(store_id=store_id, entry_date=d, **fields))
        db.session.commit()


def _service(store_id, d, service, fees, company="Intermex", amount=100.0):
    from api.Modules.DailyBook.Models import MoneyServiceSummary
    with db_session():
        db.session.add(MoneyServiceSummary(
            store_id=store_id, report_date=d, company=company,
            service=service, amount=amount, fees=fees,
        ))
        db.session.commit()


def _transfers(store_id, d, fees, company="Intermex", amount=1000.0):
    from api.Modules.DailyBook.Models import MoneyTransferSummary
    with db_session():
        db.session.add(MoneyTransferSummary(
            store_id=store_id, report_date=d, company=company,
            amount=amount, fees=fees, federal_tax=10.0,
        ))
        db.session.commit()


def _saved_rows(store_id):
    from api.Modules.Monthly.Models import MonthlyFinancial
    with db_session():
        return db.session.query(MonthlyFinancial).filter_by(
            store_id=store_id,
        ).count()


# ── The reported bug: one day is enough ─────────────────────


def test_one_daily_book_day_shows_a_pl_without_saving(client, test_store_id):
    _msb_day(test_store_id, date(Y, M, 3),
             taxable_sales=500.0, cash_expense=40.0, check_cashing_fees=25.0)

    resp = _get(client, test_store_id)

    assert resp.status_code == 200, resp.text
    r = resp.get_json()["report"]
    assert r["saved"] is False and r["id"] is None
    assert r["days_entered"] == 1
    assert r["taxable_sales"] == 500.0
    assert r["check_cashing_fees"] == 25.0
    assert r["cash_expenses"] == 40.0
    assert r["total_income"] == 525.0
    assert r["total_expenses"] == 40.0
    assert r["net_profit"] == 485.0
    assert "taxable_sales" in r["daily_fed"]
    # Reading is a pure read: nothing was stored.
    assert _saved_rows(test_store_id) == 0


def test_a_month_with_nothing_in_it_is_still_404(client, test_store_id):
    _msb_day(test_store_id, date(Y, M - 1, 3), taxable_sales=1.0)
    resp = _get(client, test_store_id)
    assert resp.status_code == 404


def test_the_month_picker_lists_months_with_daily_entries(
    client, test_store_id,
):
    _msb_day(test_store_id, date(2026, 8, 30), taxable_sales=1.0)
    _store_day(test_store_id, date(2026, 9, 2), taxable_sales=1.0)
    _put(client, test_store_id, {"notes": "saved"}, year=2026, month=6)

    body = client.get(
        "/api/v2/monthly/months",
        headers=_h(login_admin(client, test_store_id)),
    ).get_json()

    pairs = [(m["year"], m["month"]) for m in body["months"]]
    assert pairs == [(2026, 9), (2026, 8), (2026, 6)]


# ── Live: entries after a save show without a re-save ───────


def test_a_day_entered_after_saving_shows_without_resaving(
    client, test_store_id,
):
    _msb_day(test_store_id, date(Y, M, 1), cash_purchases=100.0)
    assert _put(client, test_store_id, {"credit_card_fees": 30.0}).status_code == 200

    _msb_day(test_store_id, date(Y, M, 2), cash_purchases=50.0,
             taxable_sales=900.0)
    r = _get(client, test_store_id).get_json()["report"]

    assert r["saved"] is True and r["id"] is not None
    assert r["cash_purchases"] == 150.0
    assert r["taxable_sales"] == 900.0
    # The typed line the daily book cannot know is untouched.
    assert r["credit_card_fees"] == 30.0
    assert r["total_expenses"] == 180.0
    assert r["days_entered"] == 2


# ── Which book feeds which line ─────────────────────────────


def test_store_daily_book_feeds_sales_purchases_and_expenses(
    client, test_store_id,
):
    _store_day(test_store_id, date(Y, M, 4),
               taxable_sales=1200.0, non_taxable_sales=300.0,
               paid_out_purchases=80.0, paid_out_expenses=20.0,
               check_paid_purchases=400.0, check_paid_expenses=60.0,
               check_paid_payroll=700.0, check_fees=15.0)

    r = _get(client, test_store_id).get_json()["report"]

    assert r["taxable_sales"] == 1200.0
    assert r["non_taxable"] == 300.0
    assert r["cash_purchases"] == 80.0
    assert r["cash_expenses"] == 20.0
    assert r["check_purchases"] == 400.0
    assert r["check_expenses"] == 60.0
    assert r["check_payroll"] == 700.0
    assert r["check_cashing_fees"] == 15.0


def test_both_books_on_one_day_add_up(client, test_store_id):
    _msb_day(test_store_id, date(Y, M, 5), taxable_sales=100.0)
    _store_day(test_store_id, date(Y, M, 5), taxable_sales=250.0)
    r = _get(client, test_store_id).get_json()["report"]
    assert r["taxable_sales"] == 350.0
    assert r["days_entered"] == 1


def test_services_box_fees_feed_their_lines(client, test_store_id):
    d = date(Y, M, 6)
    _msb_day(test_store_id, d, money_order_fees=2.0)
    _service(test_store_id, d, "bill_payment", 3.0)
    _service(test_store_id, d, "top_up", 1.5)
    _service(test_store_id, d, "recharge", 1.0)
    _service(test_store_id, d, "money_order", 4.0)
    _transfers(test_store_id, d, 12.0)
    _transfers(test_store_id, d, 8.0, company="Maxi")

    r = _get(client, test_store_id).get_json()["report"]

    assert r["bill_payment_charge"] == 3.0
    assert r["phone_recargas"] == 2.5
    assert r["money_order_fees"] == 6.0
    # Amounts and federal tax pass through, and money transfer fees
    # come back as next month's commission deposit — not income here.
    assert "money_transfer_fees" not in r
    assert r["total_income"] == 3.0 + 2.5 + 6.0
    assert {"bill_payment_charge", "phone_recargas", "money_order_fees",
            "cash_purchases"} <= set(r["daily_fed"])


def test_other_months_and_other_stores_do_not_leak_in(client, test_store_id):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other", slug="feed-other", email="o@x.com",
                      plan="basic")
        db.session.add(other); db.session.commit()
        other_id = other.id
    _msb_day(test_store_id, date(Y, M, 7), taxable_sales=10.0)
    _msb_day(test_store_id, date(Y, M + 1, 1), taxable_sales=999.0)
    _msb_day(other_id, date(Y, M, 7), taxable_sales=5000.0)
    _store_day(other_id, date(Y, M, 7), paid_out_expenses=5000.0)

    r = _get(client, test_store_id).get_json()["report"]

    assert r["taxable_sales"] == 10.0
    assert r["cash_expenses"] == 0.0


# ── Typed values, the bank feed and old months ──────────────


def test_a_typed_line_stands_until_the_daily_book_has_a_figure(
    client, test_store_id,
):
    _msb_day(test_store_id, date(Y, M, 8), cash_purchases=10.0)
    _put(client, test_store_id, {"taxable_sales": 7000.0, "non_taxable": 50.0})

    r = _get(client, test_store_id).get_json()["report"]
    assert r["taxable_sales"] == 7000.0
    assert "taxable_sales" not in r["daily_fed"]

    _msb_day(test_store_id, date(Y, M, 9), taxable_sales=640.0)
    r = _get(client, test_store_id).get_json()["report"]
    assert r["taxable_sales"] == 640.0
    assert "taxable_sales" in r["daily_fed"]
    assert r["non_taxable"] == 50.0


def test_saving_writes_the_daily_figure_over_a_stale_typed_one(
    client, test_store_id,
):
    from api.Modules.Monthly.Models import MonthlyFinancial
    _msb_day(test_store_id, date(Y, M, 10), taxable_sales=640.0,
             cash_expense=12.0)

    resp = _put(client, test_store_id, {"taxable_sales": 1.0, "other_taxes": 9.0})

    assert resp.status_code == 200
    with db_session():
        row = db.session.query(MonthlyFinancial).filter_by(
            store_id=test_store_id, year=Y, month=M,
        ).one()
        assert float(row.taxable_sales) == 640.0
        assert float(row.cash_expenses) == 12.0
        assert float(row.other_taxes) == 9.0


def test_bank_feed_still_wins_over_the_daily_book(client, test_store_id):
    from api.Modules.BankSync.Models import BankTransaction, StripeBankAccount
    _msb_day(test_store_id, date(Y, M, 11), rebates_commissions=40.0)
    with db_session():
        a = StripeBankAccount(
            store_id=test_store_id, stripe_account_id="fcacc_feed",
            institution_name="Bank", last4="0230", enabled=True,
        )
        db.session.add(a); db.session.flush()
        db.session.add(BankTransaction(
            store_id=test_store_id, stripe_bank_account_id=a.id,
            stripe_transaction_id="txn_feed_1", amount_cents=15_000,
            description="REBATE", category_slug="pl_rebates_commissions",
            posted_at=datetime(Y, M, 12, 9), status="posted",
        ))
        db.session.commit()

    r = _get(client, test_store_id).get_json()["report"]

    assert r["rebates_commissions"] == 150.0
    assert "rebates_commissions" in r["bank_locked"]
    assert "rebates_commissions" not in r["daily_fed"]


def test_a_saved_month_without_daily_entries_keeps_its_figures(
    client, test_store_id,
):
    """A month saved before the daily book was used: its stored
    purchases / expenses must not read as zero now."""
    from api.Modules.Monthly.Models import MonthlyFinancial
    with db_session():
        db.session.add(MonthlyFinancial(
            store_id=test_store_id, year=2025, month=3,
            taxable_sales=900.0, cash_expenses=120.0, cash_payroll=300.0,
        ))
        db.session.commit()

    r = _get(client, test_store_id, year=2025, month=3).get_json()["report"]

    assert r["cash_expenses"] == 120.0
    assert r["cash_payroll"] == 300.0
    assert r["days_entered"] == 0
    assert r["daily_fed"] == []
    assert r["net_profit"] == 480.0


# ── Access ──────────────────────────────────────────────────


def test_employee_without_monthly_read_is_refused(test_store_id):
    _msb_day(test_store_id, date(Y, M, 13), taxable_sales=10.0)
    c, jwt = make_employee_client(test_store_id)
    resp = c.get(f"/api/v2/monthly/{Y}/{M}", headers=_h(jwt))
    assert resp.status_code == 403
    resp = c.get("/api/v2/monthly/months", headers=_h(jwt))
    assert resp.status_code == 403


def test_employee_granted_monthly_read_sees_the_live_month(
    client, test_store_id,
):
    from tests.Modules.Admin.test_access_roles import (
        _assign, _create_role, _matrix,
    )
    _msb_day(test_store_id, date(Y, M, 14), taxable_sales=10.0)
    c, jwt = make_employee_client(test_store_id, username_suffix="bookkeeper")
    from api.Modules.Tenancy.Models import User
    with db_session():
        uid = db.session.query(User).filter(
            User.username.like("bookkeeper_%"),
        ).one().id
    role = _create_role(client, test_store_id, "Books", _matrix(monthly=["read"]))
    _assign(client, test_store_id, uid, role["id"])

    from tests.conftest import login_employee
    with db_session():
        username = db.session.get(User, uid).username
    resp = c.get(f"/api/v2/monthly/{Y}/{M}",
                 headers=_h(login_employee(c, test_store_id, username)))
    assert resp.status_code == 200
    assert resp.get_json()["report"]["taxable_sales"] == 10.0


@pytest.mark.parametrize("path", [f"/api/v2/monthly/{Y}/{M}", "/api/v2/monthly/months"])
def test_superadmin_is_refused(client, path):
    from tests.conftest import login_superadmin
    resp = client.get(path, headers=_h(login_superadmin(client)))
    assert resp.status_code == 403


# ── The owner roll-up and dashboard read the same live month ─


def test_owner_rollup_counts_a_month_nobody_saved(client, test_store_id):
    from tests.conftest import owner_token_for
    _msb_day(test_store_id, date(Y, M, 15), taxable_sales=800.0,
             cash_purchases=300.0)
    token = owner_token_for([test_store_id])

    body = client.get(
        f"/api/v2/owner/pl-rollup?year={Y}&month={M}", headers=_h(token),
    ).get_json()

    row = body["rows"][0]
    assert row["has_pl"] is True
    assert row["revenue"] == 800.0
    assert row["purchases"] == 300.0
    assert row["net"] == 500.0
