"""Suggestions on the Monthly P&L's Transactions tab and "Accept"
(owner 2026-11-27: one click, templates shown without "Use") —
Services/suggestions.py, Monthly INVARIANTS "Suggestions".

* history: the store's newest tag for the same words, same direction;
* template: a platform rule template that fires, when no history;
* nothing suggested for a category the store cannot pick;
* Accept (one row / all) tags through the normal write path, leaves
  locked days and possible doubles to review, writes one audit row;
* the switch and `bank_sync.update` gate it; store scope.
"""
from datetime import date, datetime

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client
from tests.Modules.Monthly.test_transactions_ledger import (
    M, Y, _account, _bank, _entry, _flags, _h, _msb_day,
)

URL = f"/api/v2/monthly/{Y}/{M}/transactions"
ACCEPT = f"{URL}/accept"


def _admin(client, sid):
    return _h(login_admin(client, sid))


def _rows(client, sid, **params):
    body = client.get(
        URL, query_string={"per_page": 200, **params},
        headers=_admin(client, sid),
    ).get_json()
    return body, {r["description"]: r for r in body["rows"]}


def _template(desc, target, sign="debit"):
    from api.Modules.BankSync.Models import BankRuleTemplate
    with db_session():
        db.session.add(BankRuleTemplate(
            name=desc, enabled=True, desc_match_type="contains",
            desc_match_value=desc, sign_filter=sign, target_kind=target,
        ))
        db.session.commit()


def _slug(txn_id):
    from api.Modules.BankSync.Models import BankTransaction
    with db_session():
        return db.session.get(BankTransaction, txn_id).category_slug


def test_description_words_drop_what_changes_every_time():
    from api.Modules.Monthly.Services.suggestions import description_words
    assert description_words("SQUARE INC 8834412 04/29") == "SQUARE INC"
    assert description_words("Remote deposit fee 2026-05-06") == "REMOTE DEPOSIT FEE"
    assert description_words("123456") == "123456"


def test_history_suggests_the_stores_newest_tag_for_the_same_words(
    client, test_store_id,
):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _bank(sid, acct, -4000, datetime(Y, 9, 7), "pl_accounting_charges", desc="SQUARE INC 111")
    _bank(sid, acct, -4100, datetime(Y, 10, 7), "pl_credit_card_fees", desc="SQUARE INC 222")
    _bank(sid, acct, -4200, datetime(Y, M, 7), desc="SQUARE INC 333")
    # Same words, money the other way: no suggestion.
    _bank(sid, acct, 900, datetime(Y, M, 8), desc="SQUARE INC 444")
    _msb_day(sid, date(Y, M, 1), taxable_sales=1.0)
    body, rows = _rows(client, sid)
    assert rows["SQUARE INC 333"]["suggested_slug"] == "pl_credit_card_fees"
    assert rows["SQUARE INC 333"]["suggested_source"] == "history"
    assert rows["SQUARE INC 444"]["suggested_slug"] == ""
    assert body["suggested"] == 1


def test_a_platform_template_is_suggested_without_using_it(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _template("QUICKBOOKS", "pl_accounting_charges")
    _bank(sid, acct, -3000, datetime(Y, M, 7), desc="INTUIT QUICKBOOKS 99")
    _msb_day(sid, date(Y, M, 1), taxable_sales=1.0)
    _, rows = _rows(client, sid)
    r = rows["INTUIT QUICKBOOKS 99"]
    assert (r["suggested_slug"], r["suggested_source"]) == (
        "pl_accounting_charges", "template",
    )
    from api.Modules.BankSync.Models import BankRule
    with db_session():
        assert db.session.query(BankRule).filter_by(store_id=sid).count() == 0


def test_history_beats_a_template(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _template("QUICKBOOKS", "pl_accounting_charges")
    _bank(sid, acct, -3000, datetime(Y, 10, 7), "pl_credit_card_fees", desc="QUICKBOOKS")
    _bank(sid, acct, -3000, datetime(Y, M, 7), desc="QUICKBOOKS 1")
    _msb_day(sid, date(Y, M, 1), taxable_sales=1.0)
    _, rows = _rows(client, sid)
    assert rows["QUICKBOOKS 1"]["suggested_source"] == "history"


def test_no_suggestion_for_a_category_the_store_cannot_pick(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _template("MYSTERY", "pl_other_expense_4")  # an unnamed slot
    _bank(sid, acct, -3000, datetime(Y, M, 7), desc="MYSTERY CO")
    _msb_day(sid, date(Y, M, 1), taxable_sales=1.0)
    _, rows = _rows(client, sid)
    assert rows["MYSTERY CO"]["suggested_slug"] == ""


def test_tagged_rows_carry_no_suggestion(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _template("QUICKBOOKS", "pl_accounting_charges")
    _bank(sid, acct, -3000, datetime(Y, M, 7), "internal_transfer", desc="QUICKBOOKS")
    _msb_day(sid, date(Y, M, 1), taxable_sales=1.0)
    _, rows = _rows(client, sid)
    assert rows["QUICKBOOKS"]["suggested_slug"] == ""


# ── Accept ──────────────────────────────────────────────────


def test_accept_all_tags_every_suggestion(client, test_store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _template("QUICKBOOKS", "pl_accounting_charges")
    _template("SQUARE", "pl_credit_card_fees")
    a = _bank(sid, acct, -3000, datetime(Y, M, 7), desc="QUICKBOOKS 1")
    b = _bank(sid, acct, -4500, datetime(Y, M, 8), desc="SQUARE 2")
    c = _bank(sid, acct, -999, datetime(Y, M, 9), desc="ZELLE")
    _msb_day(sid, date(Y, M, 1), taxable_sales=1.0)

    resp = client.post(ACCEPT, json={}, headers=_admin(client, sid))
    assert resp.status_code == 200, resp.text
    assert resp.get_json() == {"accepted": 2, "locked": 0, "maybe_in_daily_book": 0}
    assert (_slug(a), _slug(b), _slug(c)) == (
        "pl_accounting_charges", "pl_credit_card_fees", "",
    )
    report = client.get(
        f"/api/v2/monthly/{Y}/{M}", headers=_admin(client, sid),
    ).get_json()["report"]
    assert report["accounting_charges"] == 30.0
    assert report["credit_card_fees"] == 45.0
    with db_session():
        audit = db.session.query(OperatorAuditLog).filter_by(
            action="accept_bank_suggestions",
        ).all()
    assert len(audit) == 1 and "accepted=2" in audit[0].summary


def test_accept_one_row(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _template("QUICKBOOKS", "pl_accounting_charges")
    a = _bank(sid, acct, -3000, datetime(Y, M, 7), desc="QUICKBOOKS 1")
    b = _bank(sid, acct, -3100, datetime(Y, M, 8), desc="QUICKBOOKS 2")
    _msb_day(sid, date(Y, M, 1), taxable_sales=1.0)
    resp = client.post(ACCEPT, json={"txn_ids": [a]}, headers=_admin(client, sid))
    assert resp.get_json()["accepted"] == 1
    assert (_slug(a), _slug(b)) == ("pl_accounting_charges", "")


def test_accept_leaves_possible_doubles_and_locked_days_to_review(
    client, test_store_id,
):
    from api.Modules.DailyBook.Models import DailyReport
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    _template("CHECK", "pl_accounting_charges")
    _template("HOME DEPOT", "cash_expense")
    _entry(sid, date(Y, M, 3), "check_expense", 180.0)
    twin = _bank(sid, acct, -18000, datetime(Y, M, 20), desc="CHECK 2001")
    shut = _bank(sid, acct, -6000, datetime(Y, M, 21), desc="HOME DEPOT 5")
    with db_session():
        db.session.add(DailyReport(
            store_id=sid, report_date=date(Y, M, 21), locked_at=datetime(Y, M, 22),
        ))
        db.session.commit()
    resp = client.post(ACCEPT, json={}, headers=_admin(client, sid))
    assert resp.get_json() == {"accepted": 0, "locked": 1, "maybe_in_daily_book": 1}
    assert (_slug(twin), _slug(shut)) == ("", "")


def test_accept_needs_the_switch_and_bank_update(client, test_store_id):
    sid = test_store_id
    assert client.post(ACCEPT, json={}, headers=_admin(client, sid)).status_code == 403
    _flags(sid)
    c, jwt = make_employee_client(sid, username_suffix="viewer", permissions={
        "monthly": {"read": True}, "bank_sync": {"read": True, "update": False},
    })
    assert c.post(ACCEPT, json={}, headers=_h(jwt)).status_code == 403
    c, jwt = make_employee_client(sid, username_suffix="tagger", permissions={
        "monthly": {"read": True}, "bank_sync": {"read": True, "update": True},
    })
    assert c.post(ACCEPT, json={}, headers=_h(jwt)).status_code == 200


def test_accept_touches_only_this_stores_rows(client, test_store_id):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other sugg", slug="other-sugg", plan="trial")
        db.session.add(other)
        db.session.commit()
        other_id = other.id
    _flags(test_store_id)
    _flags(other_id)
    _template("QUICKBOOKS", "pl_accounting_charges")
    acct = _account(other_id, acct="fcacc_other_sugg")
    theirs = _bank(other_id, acct, -3000, datetime(Y, M, 7), desc="QUICKBOOKS")
    resp = client.post(
        ACCEPT, json={"txn_ids": [theirs]}, headers=_admin(client, test_store_id),
    )
    assert resp.get_json()["accepted"] == 0
    assert _slug(theirs) == ""
