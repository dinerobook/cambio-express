"""Daily book entries on another P&L line (owner plan 2026-11-27,
PR 4) — Services/entry_categories.py, Monthly INVARIANTS "Daily
entries on another line".

* a cash / check expense or purchase entry put on an expense line
  leaves its own line and counts there, on read and on save;
* a `pl_*` line adds it to the bank's sum, or speaks for the line
  alone (the typed value stops counting); a store category adds it;
* the Transactions tab keeps adding up, the bank row booked from an
  entry follows it;
* allowed on a locked day; validation; history suggestions and
  Accept; access, switch, store scope, audit.
"""
from datetime import date, datetime

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client
from tests.Modules.Monthly.test_transactions_ledger import (
    M, Y, _account, _all_rows, _bank, _categorize, _entry, _flags, _h,
    _msb_day,
)

ACCEPT = f"/api/v2/monthly/{Y}/{M}/transactions/accept"


def _admin(client, sid):
    return _h(login_admin(client, sid))


def _put(client, sid, entry_id, slug, headers=None):
    return client.put(
        f"/api/v2/monthly/entries/{entry_id}/category",
        json={"slug": slug}, headers=headers or _admin(client, sid),
    )


def _report(client, sid):
    return client.get(
        f"/api/v2/monthly/{Y}/{M}", headers=_admin(client, sid),
    ).get_json()["report"]


def _stored(entry_id):
    from api.Modules.DailyBook.Models import DailyLineItem
    with db_session():
        return db.session.get(DailyLineItem, entry_id).pl_category


def _adds_up(client, sid):
    from api.Modules.Monthly.Services import EXPENSE_FIELDS, INCOME_FIELDS
    report = _report(client, sid)
    body, rows = _all_rows(client, sid)
    by_line: dict[str, float] = {}
    for r in rows:
        if r["counted"]:
            by_line[r["line"]] = round(by_line.get(r["line"], 0) + r["amount"], 2)
    for line in (*INCOME_FIELDS, *EXPENSE_FIELDS):
        assert by_line.get(line, 0) == report[line], line
    for c in report["custom_lines"]:
        assert by_line.get(c["slug"], 0) == c["amount"], c["name"]
    assert body["total_expenses"] == report["total_expenses"]
    return report, body, rows


def test_an_entry_moves_to_an_expense_line(client, test_store_id):
    from api.Modules.Monthly.Models import MonthlyFinancial
    sid = test_store_id
    _flags(sid)
    _account(sid)
    ice = _entry(sid, date(Y, M, 3), "cash_expense", 40.0, "ice")
    acct = _entry(sid, date(Y, M, 4), "cash_expense", 150.0, "CPA Lopez")
    with db_session():
        # A typed figure for the line: the entries speak for it now.
        db.session.add(MonthlyFinancial(
            store_id=sid, year=Y, month=M, accounting_charges=999.0,
        ))
        db.session.commit()
    before = _report(client, sid)
    resp = _put(client, sid, acct, "pl_accounting_charges")
    assert resp.status_code == 200, resp.text
    assert resp.get_json() == {"entry_id": acct, "entry_category": "pl_accounting_charges"}
    r, _, rows = _adds_up(client, sid)
    assert r["cash_expenses"] == 40.0
    assert r["accounting_charges"] == 150.0
    assert "accounting_charges" in r["daily_fed"]
    assert r["total_expenses"] == before["total_expenses"] - 999.0
    row = next(x for x in rows if x["entry_id"] == acct)
    assert (row["line"], row["entry_category"], row["counted"]) == (
        "accounting_charges", "pl_accounting_charges", True,
    )
    assert next(x for x in rows if x["entry_id"] == ice)["entry_category"] == ""
    # Back on its own line.
    assert _put(client, sid, acct, "").status_code == 200
    assert _stored(acct) is None
    r = _report(client, sid)
    assert (r["cash_expenses"], r["accounting_charges"]) == (190.0, 999.0)


def test_on_a_bank_fed_line_it_adds_to_the_bank(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _bank(sid, acct, -4500, datetime(Y, M, 7, 10), "pl_credit_card_fees")
    e = _entry(sid, date(Y, M, 3), "check_expense", 20.0, "Square fee")
    _put(client, sid, e, "pl_credit_card_fees")
    r, _, _ = _adds_up(client, sid)
    assert r["credit_card_fees"] == 65.0
    assert r["check_expenses"] == 0.0
    assert "credit_card_fees" in r["bank_locked"]


def test_on_a_store_category(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    _msb_day(sid, date(Y, M, 1), taxable_sales=100.0)
    cat = client.post(
        "/api/v2/monthly/categories/custom",
        json={"name": "Ice", "section": "expense"}, headers=_admin(client, sid),
    ).get_json()["category"]
    e = _entry(sid, date(Y, M, 3), "cash_purchase", 30.0, "ice")
    assert _put(client, sid, e, cat["slug"]).status_code == 200
    r, _, rows = _adds_up(client, sid)
    assert r["custom_lines"] == [{
        "id": cat["id"], "slug": cat["slug"], "name": "Ice",
        "section": "expense", "amount": 30.0,
    }]
    assert r["cash_purchases"] == 0.0 and r["total_expenses"] == 30.0
    assert next(x for x in rows if x["entry_id"] == e)["bucket"] == "expense"
    listed = client.get(
        "/api/v2/monthly/categories/custom", headers=_admin(client, sid),
    ).get_json()["rows"]
    assert listed[0]["in_use"] == 1


def test_a_bank_row_booked_from_an_entry_follows_it(client, test_store_id):
    from api.Modules.BankSync.Models import BankTransaction
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    txn = _bank(sid, acct, -6000, datetime(Y, M, 9, 10))
    assert _categorize(client, sid, txn, "cash_expense").status_code == 200
    with db_session():
        item_id = db.session.get(BankTransaction, txn).daily_line_item_id
    _, rows = _all_rows(client, sid)
    bank_row = next(x for x in rows if x["txn_id"] == txn)
    assert bank_row["entry_id"] == item_id
    _put(client, sid, item_id, "pl_accounting_charges")
    r, _, rows = _adds_up(client, sid)
    assert r["accounting_charges"] == 60.0
    bank_row = next(x for x in rows if x["txn_id"] == txn)
    assert (bank_row["line"], bank_row["counted"]) == ("accounting_charges", True)


def test_saving_the_month_stores_the_moved_figures(client, test_store_id):
    from api.Modules.Monthly.Models import MonthlyFinancial
    sid = test_store_id
    _flags(sid)
    e = _entry(sid, date(Y, M, 3), "cash_expense", 50.0, "CPA")
    _entry(sid, date(Y, M, 3), "cash_expense", 10.0, "ice")
    _put(client, sid, e, "pl_accounting_charges")
    resp = client.put(
        f"/api/v2/monthly/{Y}/{M}", json={"accounting_charges": 7.0},
        headers=_admin(client, sid),
    )
    assert resp.status_code == 200, resp.text
    with db_session():
        row = db.session.query(MonthlyFinancial).filter_by(
            store_id=sid, year=Y, month=M,
        ).one()
        assert (row.cash_expenses, row.accounting_charges) == (10.0, 50.0)


def test_allowed_on_a_locked_day(client, test_store_id):
    from api.Modules.DailyBook.Models import DailyReport
    sid = test_store_id
    _flags(sid)
    e = _entry(sid, date(Y, M, 3), "cash_expense", 50.0, "CPA")
    with db_session():
        rep = db.session.query(DailyReport).filter_by(
            store_id=sid, report_date=date(Y, M, 3),
        ).one()
        rep.locked_at = datetime(Y, M, 4)
        db.session.commit()
    assert _put(client, sid, e, "pl_accounting_charges").status_code == 200
    assert _report(client, sid)["accounting_charges"] == 50.0


def test_what_can_move_and_where(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    e = _entry(sid, date(Y, M, 3), "cash_expense", 50.0)
    pay = _entry(sid, date(Y, M, 3), "payroll_cash", 500.0)
    inc = client.post(
        "/api/v2/monthly/categories/custom",
        json={"name": "Lotto", "section": "income"}, headers=_admin(client, sid),
    ).get_json()["category"]
    assert _put(client, sid, pay, "pl_accounting_charges").status_code == 422
    # Income lines, an unnamed slot, a store's income category, junk.
    for slug in ("pl_mt_commission_in_bank", "pl_other_expense_4", inc["slug"],
                 "cash_expense", "plc_999"):
        assert _put(client, sid, e, slug).status_code == 422, slug
    assert _stored(e) is None
    body, _ = _all_rows(client, sid)
    targets = {t["slug"] for t in body["entry_targets"]}
    assert "pl_accounting_charges" in targets
    assert not targets & {"pl_mt_commission_in_bank", "pl_other_expense_4", inc["slug"]}


def test_off_nothing_moves(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    e = _entry(sid, date(Y, M, 3), "cash_expense", 50.0)
    _put(client, sid, e, "pl_accounting_charges")
    _flags(sid, pl=False)
    assert _put(client, sid, e, "").status_code == 403
    r = _report(client, sid)
    assert (r["cash_expenses"], r["accounting_charges"]) == (50.0, 0.0)


def test_needs_monthly_update(test_store_id):
    sid = test_store_id
    _flags(sid)
    e = _entry(sid, date(Y, M, 3), "cash_expense", 50.0)
    c, jwt = make_employee_client(sid, username_suffix="entryread", permissions={
        "monthly": {"read": True, "update": False},
    })
    assert _put(c, sid, e, "pl_accounting_charges", headers=_h(jwt)).status_code == 403
    c, jwt = make_employee_client(sid, username_suffix="entryupd", permissions={
        "monthly": {"read": True, "update": True},
    })
    assert _put(c, sid, e, "pl_accounting_charges", headers=_h(jwt)).status_code == 200


def test_another_stores_entry_is_out_of_reach(client, test_store_id):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other entries", slug="other-entries", plan="trial")
        db.session.add(other)
        db.session.commit()
        other_id = other.id
    _flags(test_store_id)
    _flags(other_id)
    theirs = _entry(other_id, date(Y, M, 3), "cash_expense", 50.0)
    assert _put(client, test_store_id, theirs, "pl_accounting_charges").status_code == 404
    assert _stored(theirs) is None


def test_every_change_is_audited(client, test_store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    sid = test_store_id
    _flags(sid)
    e = _entry(sid, date(Y, M, 3), "cash_expense", 50.0)
    _put(client, sid, e, "pl_accounting_charges")
    _put(client, sid, e, "")
    with db_session():
        rows = db.session.query(OperatorAuditLog).filter_by(
            action="monthly_entry_category",
        ).order_by(OperatorAuditLog.id).all()
        assert [a.summary for a in rows] == [
            "- -> pl_accounting_charges", "pl_accounting_charges -> -",
        ]


# ── Suggestions ─────────────────────────────────────────────


def test_history_suggests_where_the_last_one_went_and_accept_moves_it(
    client, test_store_id,
):
    sid = test_store_id
    _flags(sid)
    old = _entry(sid, date(Y, 10, 3), "cash_expense", 150.0, "CPA Lopez 10/03")
    _put(client, sid, old, "pl_accounting_charges")
    new = _entry(sid, date(Y, M, 3), "cash_expense", 150.0, "CPA Lopez 11/03")
    other = _entry(sid, date(Y, M, 4), "check_expense", 150.0, "CPA Lopez")
    body, rows = _all_rows(client, sid)
    row = next(x for x in rows if x["entry_id"] == new)
    assert (row["suggested_slug"], row["suggested_source"]) == (
        "pl_accounting_charges", "history",
    )
    # Another kind: no suggestion.
    assert next(x for x in rows if x["entry_id"] == other)["suggested_slug"] == ""
    assert body["suggested"] == 1
    resp = client.post(ACCEPT, json={"entry_ids": [new]}, headers=_admin(client, sid))
    assert resp.get_json() == {"accepted": 1, "locked": 0, "maybe_in_daily_book": 0}
    assert _stored(new) == "pl_accounting_charges"
    assert _report(client, sid)["accounting_charges"] == 150.0


def test_accept_all_moves_entries_only_for_someone_who_may(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    old = _entry(sid, date(Y, 10, 3), "cash_expense", 10.0, "ICE CO")
    _put(client, sid, old, "pl_accounting_charges")
    new = _entry(sid, date(Y, M, 3), "cash_expense", 10.0, "ICE CO")
    c, jwt = make_employee_client(sid, username_suffix="bankonly", permissions={
        "monthly": {"read": True, "update": False},
        "bank_sync": {"read": True, "update": True},
    })
    assert c.post(ACCEPT, json={}, headers=_h(jwt)).get_json()["accepted"] == 0
    assert c.post(ACCEPT, json={"entry_ids": [new]}, headers=_h(jwt)).status_code == 403
    assert _stored(new) is None
    c, jwt = make_employee_client(sid, username_suffix="pleditor", permissions={
        "monthly": {"read": True, "update": True},
        "bank_sync": {"read": True, "update": False},
    })
    assert c.post(ACCEPT, json={}, headers=_h(jwt)).get_json()["accepted"] == 1
    assert _stored(new) == "pl_accounting_charges"
