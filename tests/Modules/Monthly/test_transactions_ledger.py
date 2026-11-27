"""The Monthly P&L's Transactions tab (`pl_transactions`, owner
2026-11-27) — Services/ledger.py, INVARIANTS.md "Transactions".

* every dollar of the month is one row, and the counted rows add up
  to the statement line by line, for every source (bank P&L tags,
  bank charges, bank rows on the daily book, MSB entries, an older
  day typed as one total, the Store daily book, the Services box,
  typed lines);
* a bank row on the daily book is listed once, as the bank row;
* month-end: with the switch on, a bank row counts in the month of
  its booking day; off, nothing changes;
* the double-count guard on putting a bank row on a P&L line;
* the switch (and bank matching under it), access and store scope.
"""
from datetime import date, datetime

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client

Y, M = 2026, 11
URL = f"/api/v2/monthly/{Y}/{M}/transactions"


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _admin(client, sid):
    return _h(login_admin(client, sid))


def _flags(sid, *, pl=True, matching=True):
    from api.Modules.Billing.Models import StoreFeatureOverride
    with db_session():
        for key, on in (("pl_transactions", pl), ("bank_matching", matching)):
            row = db.session.query(StoreFeatureOverride).filter_by(
                store_id=sid, flag_key=key,
            ).first()
            if row is None:
                db.session.add(StoreFeatureOverride(
                    store_id=sid, flag_key=key, enabled=on,
                ))
            else:
                row.enabled = on
        db.session.commit()


def _account(sid, acct="fcacc_ledger"):
    from api.Modules.BankSync.Models import StripeBankAccount
    with db_session():
        a = StripeBankAccount(
            store_id=sid, stripe_account_id=acct,
            institution_name="Bank", last4="0230", enabled=True,
        )
        db.session.add(a)
        db.session.commit()
        return a.id


_n = [0]


def _bank(sid, acct, cents, posted, slug="", desc="X", override=None):
    from api.Modules.BankSync.Models import BankTransaction
    _n[0] += 1
    with db_session():
        t = BankTransaction(
            store_id=sid, stripe_bank_account_id=acct,
            stripe_transaction_id=f"txn_ledger_{_n[0]}", amount_cents=cents,
            description=desc, category_slug=slug, posted_at=posted,
            status="posted", report_date_override=override,
        )
        db.session.add(t)
        db.session.commit()
        return t.id


def _msb_day(sid, d, **fields):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        db.session.add(DailyReport(store_id=sid, report_date=d, **fields))
        db.session.commit()


def _entry(sid, d, kind, amount, note=""):
    """A cashier's entry, rolled into the day's total the way the
    daily book does it."""
    from api.Modules.DailyBook.Services import LINE_ITEM_KINDS
    from api.Modules.DailyBook.Models import DailyLineItem
    from api.Modules.DailyBook.Services.line_items import recompute_line_items_total
    with db_session():
        i = DailyLineItem(store_id=sid, report_date=d, kind=kind,
                          amount_cents=int(round(amount * 100)), note=note)
        db.session.add(i)
        db.session.flush()
        recompute_line_items_total(
            db.session, sid, d, kind=kind,
            daily_report_field=LINE_ITEM_KINDS[kind][0],
        )
        db.session.commit()
        return i.id


def _get(client, sid, **params):
    return client.get(URL, query_string=params, headers=_admin(client, sid))


def _all_rows(client, sid, **params):
    body = _get(client, sid, per_page=200, **params).get_json()
    return body, body["rows"]


def _categorize(client, sid, txn_id, slug, **extra):
    return client.post(
        f"/api/v2/bank/transactions/{txn_id}/categorize",
        json={"target_kind": slug, **extra}, headers=_admin(client, sid),
    )


# ── the statement adds up ───────────────────────────────────


def test_counted_rows_add_up_to_every_statement_line(client, test_store_id):
    from api.Modules.DailyBook.Models import MoneyServiceSummary
    from api.Modules.Monthly.Models import MonthlyFinancial
    from api.Modules.StoreBook.Models import StoreDailyEntry
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    # MSB: a sales day, entries, an older day typed as one total.
    _msb_day(sid, date(Y, M, 2), taxable_sales=900.0, over_short=-3.0,
             check_cashing_fees=12.0, cash_expense=25.0)
    _entry(sid, date(Y, M, 3), "cash_expense", 40.0, "ice")
    _entry(sid, date(Y, M, 3), "check_purchase", 300.0, "Coke")
    _entry(sid, date(Y, M, 4), "payroll_check", 700.0, "Ana")
    with db_session():
        db.session.add(StoreDailyEntry(
            store_id=sid, entry_date=date(Y, M, 5), taxable_sales=1200.0,
            paid_out_expenses=20.0, check_fees=15.0,
        ))
        db.session.add(MoneyServiceSummary(
            store_id=sid, report_date=date(Y, M, 6), company="Intermex",
            service="bill_payment", amount=100.0, fees=3.0,
        ))
        db.session.add(MonthlyFinancial(
            store_id=sid, year=Y, month=M, money_order_rent=150.0,
        ))
        db.session.commit()
    # Bank: P&L tags, a charge, one booked onto the daily book, one
    # to review, one that is not P&L money.
    _bank(sid, acct, -4500, datetime(Y, M, 7, 10), "pl_credit_card_fees")
    _bank(sid, acct, -210, datetime(Y, M, 8, 10), "bank_charge")
    booked = _bank(sid, acct, -6000, datetime(Y, M, 9, 10))
    assert _categorize(client, sid, booked, "cash_expense").status_code == 200
    _bank(sid, acct, -999, datetime(Y, M, 10, 10))
    _bank(sid, acct, -5000, datetime(Y, M, 11, 10), "internal_transfer")

    report = client.get(
        f"/api/v2/monthly/{Y}/{M}", headers=_admin(client, sid),
    ).get_json()["report"]
    body, rows = _all_rows(client, sid)

    by_line: dict[str, float] = {}
    for r in rows:
        if r["counted"]:
            by_line[r["line"]] = round(by_line.get(r["line"], 0) + r["amount"], 2)
    from api.Modules.Monthly.Services import EXPENSE_FIELDS, INCOME_FIELDS
    for line in (*INCOME_FIELDS, *EXPENSE_FIELDS):
        assert by_line.get(line, 0) == report[line], line
    assert body["total_income"] == report["total_income"]
    assert body["total_expenses"] == report["total_expenses"]
    assert body["net_profit"] == report["net_profit"]
    assert body["days_entered"] == report["days_entered"] == 5
    assert body["days_in_month"] == 30
    # Spot checks.
    assert by_line["cash_expenses"] == 25.0 + 40.0 + 60.0 + 20.0
    assert by_line["money_order_rent"] == 150.0
    statuses = {r["status"] for r in rows}
    assert {"person", "added", "to_review", "not_in_pl", "daily",
            "typed"} <= statuses


def test_a_bank_row_on_the_daily_book_is_one_row(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    txn = _bank(sid, acct, -6000, datetime(Y, M, 9, 10), desc="HOME DEPOT")
    assert _categorize(client, sid, txn, "cash_expense").status_code == 200
    _, rows = _all_rows(client, sid)
    expense_rows = [r for r in rows if r["line"] == "cash_expenses"]
    assert len(expense_rows) == 1
    r = expense_rows[0]
    assert r["source"] == "bank" and r["status"] == "added"
    assert r["txn_id"] == txn and r["counted"] and r["amount"] == 60.0
    assert r["description"] == "HOME DEPOT" and r["bucket"] == "expense"
    assert r["booked_on"] == r["day"] == r["bank_date"] == f"{Y}-{M:02d}-09"


def test_a_matched_check_is_listed_on_the_cashiers_day(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _entry(sid, date(Y, M, 3), "check_expense", 500.0, "rent 1042")
    txn = _bank(sid, acct, -50000, datetime(Y, M, 20, 10), desc="CHECK 1042")
    assert _categorize(client, sid, txn, "check_expense").status_code == 200
    _, rows = _all_rows(client, sid)
    checks = [r for r in rows if r["line"] == "check_expenses"]
    assert len(checks) == 1
    assert checks[0]["status"] == "matched"
    assert checks[0]["day"] == f"{Y}-{M:02d}-03"


# ── month-end ───────────────────────────────────────────────


def test_month_end_a_row_counts_in_its_booking_days_month(client, test_store_id):
    sid = test_store_id
    acct = _account(sid)
    # Posted Dec 1, belongs to Nov 30.
    _bank(sid, acct, -2500, datetime(Y, 12, 1, 9), "pl_accounting_charges",
          override=date(Y, 11, 30))
    _msb_day(sid, date(Y, 11, 30), taxable_sales=1.0)
    _msb_day(sid, date(Y, 12, 2), taxable_sales=1.0)

    def line(month):
        return client.get(
            f"/api/v2/monthly/{Y}/{month}", headers=_admin(client, sid),
        ).get_json()["report"]["accounting_charges"]

    # Off: the bank's posting date, as before.
    assert (line(11), line(12)) == (0.0, 25.0)
    _flags(sid)
    assert (line(11), line(12)) == (25.0, 0.0)
    _, rows = _all_rows(client, sid)
    assert [r["day"] for r in rows if r["line"] == "accounting_charges"] == [
        f"{Y}-11-30",
    ]


def test_month_end_dismissed_and_void_rows_count_nowhere(client, test_store_id):
    from api.Modules.BankSync.Models import BankTransaction
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    gone = _bank(sid, acct, -1000, datetime(Y, M, 5, 9), "pl_accounting_charges")
    void = _bank(sid, acct, -2000, datetime(Y, M, 6, 9), "pl_accounting_charges")
    with db_session():
        db.session.get(BankTransaction, gone).dismissed_at = datetime(Y, M, 7)
        db.session.get(BankTransaction, void).status = "void"
        db.session.commit()
    _msb_day(sid, date(Y, M, 1), taxable_sales=1.0)
    report = client.get(
        f"/api/v2/monthly/{Y}/{M}", headers=_admin(client, sid),
    ).get_json()["report"]
    assert report["accounting_charges"] == 0.0
    _, rows = _all_rows(client, sid)
    assert not [r for r in rows if r["source"] == "bank"]


# ── views and filters ───────────────────────────────────────


def test_views_counts_and_filters(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _msb_day(sid, date(Y, M, 2), taxable_sales=900.0)
    _bank(sid, acct, -4500, datetime(Y, M, 7, 10), "pl_credit_card_fees",
          desc="SQUARE FEES")
    _bank(sid, acct, -999, datetime(Y, M, 10, 10), desc="ZELLE PAYMENT")
    _bank(sid, acct, -5000, datetime(Y, M, 11, 10), "sales_tax_paid",
          desc="COMPTROLLER")

    body, _ = _all_rows(client, sid)
    assert body["counts"] == {"review": 1, "in_pl": 2, "not_pl": 1, "all": 4}
    _, review = _all_rows(client, sid, view="review")
    assert [r["description"] for r in review] == ["ZELLE PAYMENT"]
    _, not_pl = _all_rows(client, sid, view="not_pl")
    assert [r["category_slug"] for r in not_pl] == ["sales_tax_paid"]
    _, line = _all_rows(client, sid, line="credit_card_fees")
    assert [r["description"] for r in line] == ["SQUARE FEES"]
    _, daily = _all_rows(client, sid, source="daily")
    assert [r["line"] for r in daily] == ["taxable_sales"]
    _, found = _all_rows(client, sid, q="squa")
    assert [r["description"] for r in found] == ["SQUARE FEES"]
    _, one_char = _all_rows(client, sid, q="s")
    assert len(one_char) == 4
    page = _get(client, sid, per_page=1, page=2).get_json()
    assert page["total"] == 4 and page["total_pages"] == 4
    assert len(page["rows"]) == 1
    assert _get(client, sid, view="nope").status_code == 422


def test_an_empty_month_is_an_empty_list(client, test_store_id):
    _flags(test_store_id)
    body, rows = _all_rows(client, test_store_id)
    assert rows == [] and body["total"] == 0
    assert body["counts"]["all"] == 0 and body["net_profit"] == 0.0


# ── the double-count guard ──────────────────────────────────


def test_putting_a_daily_book_check_on_a_pl_line_asks_first(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    entry = _entry(sid, date(Y, M, 3), "check_expense", 180.0, "accountant")
    txn = _bank(sid, acct, -18000, datetime(Y, M, 20, 10), desc="CHECK 2001")

    resp = _categorize(client, sid, txn, "pl_accounting_charges")
    assert resp.status_code == 409
    detail = resp.get_json()["detail"]
    assert detail["code"] == "maybe_in_daily_book"
    assert [c["id"] for c in detail["candidates"]] == [entry]
    assert detail["candidates"][0]["amount"] == 180.0
    assert detail["candidates"][0]["kind_label"] == "Check expense"
    from api.Modules.BankSync.Models import BankTransaction
    with db_session():
        assert db.session.get(BankTransaction, txn).category_slug == ""

    resp = _categorize(client, sid, txn, "pl_accounting_charges", force=True)
    assert resp.status_code == 200


def test_the_guard_ignores_entries_already_tied_to_a_bank_row(
    client, test_store_id,
):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _entry(sid, date(Y, M, 3), "check_expense", 180.0)
    first = _bank(sid, acct, -18000, datetime(Y, M, 20, 10), desc="CHECK 2001")
    assert _categorize(client, sid, first, "check_expense").status_code == 200
    second = _bank(sid, acct, -18000, datetime(Y, M, 21, 10))
    assert _categorize(client, sid, second, "pl_accounting_charges").status_code == 200


def test_the_guard_is_off_without_the_switch(client, test_store_id):
    sid = test_store_id
    _flags(sid, pl=False)
    acct = _account(sid)
    _entry(sid, date(Y, M, 3), "check_expense", 180.0)
    txn = _bank(sid, acct, -18000, datetime(Y, M, 20, 10))
    assert _categorize(client, sid, txn, "pl_accounting_charges").status_code == 200


def test_the_guard_leaves_daily_book_kinds_alone(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _entry(sid, date(Y, M, 3), "cash_expense", 180.0)
    txn = _bank(sid, acct, -18000, datetime(Y, M, 20, 10))
    assert _categorize(client, sid, txn, "internal_transfer").status_code == 200


# ── switch, access, scope ───────────────────────────────────


def test_off_unless_both_switches_are_on(client, test_store_id):
    assert _get(client, test_store_id).status_code == 403
    _flags(test_store_id, pl=True, matching=False)
    resp = _get(client, test_store_id)
    assert resp.status_code == 403
    assert resp.get_json()["detail"]["code"] == "pl_transactions_off"
    _flags(test_store_id, pl=False, matching=True)
    assert _get(client, test_store_id).status_code == 403
    _flags(test_store_id)
    assert _get(client, test_store_id).status_code == 200


def test_needs_the_pl_and_the_bank_rows(test_store_id):
    _flags(test_store_id)
    c, jwt = make_employee_client(test_store_id, permissions={
        "monthly": {"read": True}, "bank_sync": {"read": False},
    })
    assert c.get(URL, headers=_h(jwt)).status_code == 403
    c, jwt = make_employee_client(test_store_id, username_suffix="nopl", permissions={
        "monthly": {"read": False}, "bank_sync": {"read": True},
    })
    assert c.get(URL, headers=_h(jwt)).status_code == 403


def test_granted_both_an_employee_reads_the_list(test_store_id):
    _flags(test_store_id)
    _msb_day(test_store_id, date(Y, M, 2), taxable_sales=900.0)
    c, jwt = make_employee_client(test_store_id, username_suffix="books", permissions={
        "monthly": {"read": True}, "bank_sync": {"read": True},
    })
    resp = c.get(URL, headers=_h(jwt))
    assert resp.status_code == 200, resp.text
    assert resp.get_json()["counts"]["in_pl"] == 1


def test_only_this_stores_rows(client, test_store_id):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other ledger", slug="other-ledger", plan="trial")
        db.session.add(other)
        db.session.commit()
        other_id = other.id
    _flags(test_store_id)
    _flags(other_id)
    acct = _account(other_id, acct="fcacc_other_ledger")
    _bank(other_id, acct, -999, datetime(Y, M, 10, 10))
    _msb_day(other_id, date(Y, M, 2), taxable_sales=900.0)
    body, rows = _all_rows(client, test_store_id)
    assert rows == [] and body["counts"]["all"] == 0


def test_the_month_says_whether_the_tab_is_on(client, test_store_id):
    _msb_day(test_store_id, date(Y, M, 2), taxable_sales=900.0)

    def on():
        return client.get(
            f"/api/v2/monthly/{Y}/{M}", headers=_admin(client, test_store_id),
        ).get_json()["transactions_enabled"]

    assert on() is False
    _flags(test_store_id, pl=True, matching=False)
    assert on() is False
    _flags(test_store_id)
    assert on() is True


def test_same_money_links_the_entry_the_guard_named(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _entry(sid, date(Y, M, 3), "check_expense", 180.0)
    # A second entry the same day stops the automatic match.
    _entry(sid, date(Y, M, 3), "check_expense", 180.0)
    txn = _bank(sid, acct, -18000, datetime(Y, M, 20, 10))
    detail = _categorize(client, sid, txn, "pl_accounting_charges").get_json()["detail"]
    first = detail["candidates"][0]["id"]
    resp = client.post(
        f"/api/v2/bank/transactions/{txn}/match", json={"line_ids": [first]},
        headers=_admin(client, sid),
    )
    assert resp.status_code == 200, resp.text
    _, rows = _all_rows(client, sid, line="check_expenses")
    assert sorted(r["source"] for r in rows) == ["bank", "entry"]
    assert sum(r["amount"] for r in rows if r["counted"]) == 360.0


def test_the_guard_ignores_cash_entries_and_checks_outside_the_window(
    client, test_store_id,
):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _entry(sid, date(Y, M, 3), "cash_expense", 180.0)
    _entry(sid, date(Y, M, 25), "check_expense", 180.0)  # after the bank date
    txn = _bank(sid, acct, -18000, datetime(Y, M, 20, 10))
    assert _categorize(client, sid, txn, "pl_accounting_charges").status_code == 200
