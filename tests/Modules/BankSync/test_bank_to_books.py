"""K-1 — the bank feed lands in the books.

The bug that started this: tagging a batch of remote check deposits
as `check_deposit` inserted a line item but never rolled the day's
`checks_deposit` total, so the daily book showed nothing. These
tests pin the whole contract:

  * booking goes through the daily-book service path (day total
    moves, the report row is created if missing);
  * a locked day is refused (service raises, endpoint 409) and the
    row is left untouched;
  * `report_date` moves the line to another day;
  * uncategorize rolls the total back;
  * the SPA only posts slugs the server lists (`GET /bank/categories`,
    422 on anything else) and sees where a row was booked;
  * rules can be applied to existing rows (create + `apply_to_existing`,
    `POST /rules/{id}/apply`) and reordered;
  * `pl_*` categories feed the monthly P&L under the conditional lock.
"""
from datetime import date, datetime

from tests._app import db, db_session


def _login(client, store_id):
    resp = client.post(
        "/api/v2/auth/login",
        json={"username": "admin@test.com", "password": "testpass123!",
              "store_id": store_id},
    )
    return {"Authorization": f"Bearer {resp.get_json()['access_token']}"}


def _seed_account(store_id, *, last4="0230"):
    from api.Modules.BankSync.Models import StripeBankAccount
    a = StripeBankAccount(
        store_id=store_id, stripe_account_id=f"fcacc_k1_{last4}",
        institution_name="Bank", last4=last4, enabled=True,
    )
    db.session.add(a); db.session.commit()
    return a.id


_N = [0]


def _seed_txn(store_id, account_id, *, amount_cents=-100, description="X",
              posted_at=datetime(2026, 5, 6, 10, 0, 0), category_slug=""):
    from api.Modules.BankSync.Models import BankTransaction
    _N[0] += 1
    t = BankTransaction(
        store_id=store_id, stripe_bank_account_id=account_id,
        stripe_transaction_id=f"txn_k1_{_N[0]}",
        amount_cents=amount_cents, description=description,
        category_slug=category_slug, posted_at=posted_at, status="posted",
    )
    db.session.add(t); db.session.commit()
    return t.id


def _report(store_id, d):
    from api.Modules.DailyBook.Repositories import find_report_by_date
    return find_report_by_date(db.session, store_id, d)


# ── booking service ─────────────────────────────────────────


def test_booking_a_check_deposit_moves_the_days_total(test_store_id):
    """The reported bug: the line landed but `checks_deposit` stayed
    0 and the report row was never created."""
    from api.Modules.BankSync.Services import categorize_transaction
    from api.Modules.BankSync.Models import BankTransaction
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a, amount_cents=125_000,
                        description="REMOTE DEPOSIT 20 CHECKS")
        assert _report(test_store_id, date(2026, 5, 6)) is None
        txn = db.session.get(BankTransaction, tid)
        categorize_transaction(db.session, txn, "check_deposit")
        db.session.commit()
        r = _report(test_store_id, date(2026, 5, 6))
        assert r is not None
        assert abs(r.checks_deposit - 1250.0) < 0.005
        assert txn.daily_line_item_id is not None


def test_uncategorize_rolls_the_total_back(test_store_id):
    from api.Modules.BankSync.Services import (
        categorize_transaction, uncategorize_transaction,
    )
    from api.Modules.BankSync.Models import BankTransaction
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a, amount_cents=-4_000)
        txn = db.session.get(BankTransaction, tid)
        categorize_transaction(db.session, txn, "cash_expense")
        db.session.commit()
        assert abs(_report(test_store_id, date(2026, 5, 6)).cash_expense - 40.0) < 0.005
        uncategorize_transaction(db.session, txn)
        db.session.commit()
        assert _report(test_store_id, date(2026, 5, 6)).cash_expense == 0
        assert txn.daily_line_item_id is None


def test_re_categorizing_moves_between_kind_totals(test_store_id):
    from api.Modules.BankSync.Services import categorize_transaction
    from api.Modules.BankSync.Models import BankTransaction
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a, amount_cents=-4_000)
        txn = db.session.get(BankTransaction, tid)
        categorize_transaction(db.session, txn, "cash_expense")
        categorize_transaction(db.session, txn, "cash_purchase")
        db.session.commit()
        r = _report(test_store_id, date(2026, 5, 6))
        assert r.cash_expense == 0
        assert abs(r.cash_purchases - 40.0) < 0.005


def test_locked_day_refuses_booking_and_leaves_row_untouched(test_store_id):
    from api.Modules.BankSync.Services import (
        DailyBookLockedError, categorize_transaction,
    )
    from api.Modules.BankSync.Models import BankTransaction
    from api.Modules.DailyBook.Services import lock_report
    import pytest
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a, amount_cents=-4_000)
        lock_report(db.session, test_store_id, date(2026, 5, 6))
        db.session.commit()
        txn = db.session.get(BankTransaction, tid)
        with pytest.raises(DailyBookLockedError) as exc:
            categorize_transaction(db.session, txn, "cash_expense")
        assert exc.value.report_date == date(2026, 5, 6)
        assert txn.category_slug == ""
        assert txn.daily_line_item_id is None


def test_pl_category_never_touches_the_daily_book(test_store_id):
    from api.Modules.BankSync.Services import categorize_transaction
    from api.Modules.BankSync.Models import BankTransaction
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a, amount_cents=-4_000)
        txn = db.session.get(BankTransaction, tid)
        categorize_transaction(db.session, txn, "pl_credit_card_fees")
        db.session.commit()
        assert txn.category_slug == "pl_credit_card_fees"
        assert txn.daily_line_item_id is None
        assert _report(test_store_id, date(2026, 5, 6)) is None


# ── rule engine on a locked day ─────────────────────────────


def test_rule_on_locked_day_tags_without_booking(test_store_id):
    from api.Modules.BankSync.Models import BankRule, BankTransaction
    from api.Modules.BankSync.Services import apply_rule_to_existing
    from api.Modules.DailyBook.Services import lock_report
    with db_session():
        a = _seed_account(test_store_id)
        open_id = _seed_txn(test_store_id, a, amount_cents=-500,
                            description="UTILITY AUTOPAY",
                            posted_at=datetime(2026, 5, 7, 9, 0))
        locked_id = _seed_txn(test_store_id, a, amount_cents=-500,
                              description="UTILITY AUTOPAY",
                              posted_at=datetime(2026, 5, 6, 9, 0))
        lock_report(db.session, test_store_id, date(2026, 5, 6))
        rule = BankRule(
            store_id=test_store_id, enabled=True, priority=10,
            desc_match_type="contains", desc_match_value="utility",
            target_kind="cash_expense", auto_post=True,
        )
        db.session.add(rule); db.session.commit()
        rep = apply_rule_to_existing(db.session, rule)
        db.session.commit()
        assert (rep.tagged, rep.booked, rep.locked_skipped) == (2, 1, 1)
        assert db.session.get(BankTransaction, locked_id).category_slug == "cash_expense"
        assert db.session.get(BankTransaction, locked_id).daily_line_item_id is None
        assert db.session.get(BankTransaction, open_id).daily_line_item_id is not None
        assert abs(_report(test_store_id, date(2026, 5, 7)).cash_expense - 5.0) < 0.005


def test_apply_rule_never_overrides_a_hand_set_tag(test_store_id):
    from api.Modules.BankSync.Models import BankRule, BankTransaction
    from api.Modules.BankSync.Services import apply_rule_to_existing
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a, description="UTILITY",
                        category_slug="ignore")
        rule = BankRule(store_id=test_store_id, enabled=True,
                        desc_match_type="contains", desc_match_value="utility",
                        target_kind="cash_expense", auto_post=False)
        db.session.add(rule); db.session.commit()
        rep = apply_rule_to_existing(db.session, rule)
        assert rep.tagged == 0
        assert db.session.get(BankTransaction, tid).category_slug == "ignore"


def test_matcher_ends_with(test_store_id):
    from unittest.mock import MagicMock
    from api.Modules.BankSync.Services import DESC_MATCH_TYPES, rule_matches
    assert "ends_with" in DESC_MATCH_TYPES
    rule = MagicMock(enabled=True, desc_match_type="ends_with",
                     desc_match_value="fee", sign_filter="",
                     amount_min_cents=None, amount_max_cents=None,
                     account_filter_id=None)
    assert rule_matches(rule, MagicMock(description="REMOTE DEPOSIT FEE",
                                        amount_cents=-1)) is True
    assert rule_matches(rule, MagicMock(description="FEE REFUND",
                                        amount_cents=-1)) is False


# ── endpoints ───────────────────────────────────────────────


def test_categories_endpoint_lists_three_groups(client, test_store_id):
    with db_session():
        _seed_account(test_store_id, last4="9876")
    resp = client.get("/api/v2/bank/categories", headers=_login(client, test_store_id))
    assert resp.status_code == 200
    groups = resp.get_json()["groups"]
    assert [g["label"] for g in groups] == [
        "Daily book", "Monthly P&L", "Other (no daily-book impact)",
    ]
    assert groups[0]["posts_to_daily"] is True
    assert groups[1]["posts_to_daily"] is False
    daily = {o["slug"] for o in groups[0]["options"]}
    assert "check_deposit" in daily
    other = {o["slug"] for o in groups[2]["options"]}
    assert "bank_charge_9876" in other


def test_categorize_rejects_unknown_slug_with_422(client, test_store_id):
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
    resp = client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "ach_deposit"},
        headers=_login(client, test_store_id),
    )
    assert resp.status_code == 422
    assert resp.get_json()["detail"]["field"] == "target_kind"


def test_categorize_books_by_default_and_reports_booked_on(client, test_store_id):
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a, amount_cents=125_000)
    headers = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "check_deposit"}, headers=headers,
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    t = resp.get_json()["transaction"]
    assert t["booked_on"] == "2026-05-06"
    assert t["daily_line_item_id"] is not None
    # The list carries it too.
    lst = client.get("/api/v2/bank/transactions", headers=headers).get_json()
    row = next(r for r in lst["rows"] if r["id"] == tid)
    assert row["booked_on"] == "2026-05-06"
    with db_session():
        assert abs(_report(test_store_id, date(2026, 5, 6)).checks_deposit - 1250.0) < 0.005


def test_categorize_report_date_override_books_on_that_day(client, test_store_id):
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a, amount_cents=125_000)
    resp = client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "check_deposit", "report_date": "2026-05-05"},
        headers=_login(client, test_store_id),
    )
    assert resp.status_code == 200
    assert resp.get_json()["transaction"]["booked_on"] == "2026-05-05"
    with db_session():
        assert _report(test_store_id, date(2026, 5, 6)) is None
        assert abs(_report(test_store_id, date(2026, 5, 5)).checks_deposit - 1250.0) < 0.005


def test_categorize_locked_day_is_409_with_the_date(client, test_store_id):
    from api.Modules.DailyBook.Services import lock_report
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
        lock_report(db.session, test_store_id, date(2026, 5, 6))
        db.session.commit()
    resp = client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "cash_expense"},
        headers=_login(client, test_store_id),
    )
    assert resp.status_code == 409
    detail = resp.get_json()["detail"]
    assert detail["code"] == "daily_book_locked"
    assert detail["report_date"] == "2026-05-06"
    with db_session():
        from api.Modules.BankSync.Models import BankTransaction
        assert db.session.get(BankTransaction, tid).category_slug == ""


def test_categorize_and_uncategorize_write_audit_rows(client, test_store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
    headers = _login(client, test_store_id)
    client.post(f"/api/v2/bank/transactions/{tid}/categorize",
                json={"target_kind": "ignore"}, headers=headers)
    client.post(f"/api/v2/bank/transactions/{tid}/uncategorize", headers=headers)
    with db_session():
        rows = (
            db.session.query(OperatorAuditLog)
              .filter_by(store_id=test_store_id, target_type="bank_transaction",
                         target_id=str(tid))
              .all()
        )
        assert {r.action for r in rows} == {"categorize", "uncategorize"}


def test_create_rule_with_apply_to_existing_books_matching_rows(client, test_store_id):
    with db_session():
        a = _seed_account(test_store_id)
        _seed_txn(test_store_id, a, amount_cents=90_000, description="RDC DEPOSIT 04/29")
        _seed_txn(test_store_id, a, amount_cents=35_000, description="RDC DEPOSIT 05/06",
                  posted_at=datetime(2026, 5, 7, 9, 0))
        _seed_txn(test_store_id, a, amount_cents=-210, description="RDC FEE")
    resp = client.post(
        "/api/v2/bank/rules",
        json={"desc_match_type": "contains", "desc_match_value": "RDC DEPOSIT",
              "sign_filter": "credit", "target_kind": "check_deposit",
              "auto_post": True, "apply_to_existing": True},
        headers=_login(client, test_store_id),
    )
    assert resp.status_code == 201, resp.get_data(as_text=True)
    body = resp.get_json()
    assert body["applied"] == {"tagged": 2, "booked": 2, "locked_skipped": 0}
    assert body["rule"]["match_count"] == 2
    with db_session():
        assert abs(_report(test_store_id, date(2026, 5, 6)).checks_deposit - 900.0) < 0.005
        assert abs(_report(test_store_id, date(2026, 5, 7)).checks_deposit - 350.0) < 0.005


def test_create_rule_defaults_match_type_and_rejects_unknown_target(client, test_store_id):
    headers = _login(client, test_store_id)
    resp = client.post(
        "/api/v2/bank/rules",
        json={"desc_match_value": "RDC", "target_kind": "check_deposit"},
        headers=headers,
    )
    assert resp.status_code == 201
    assert resp.get_json()["rule"]["desc_match_type"] == "contains"
    assert resp.get_json()["applied"] is None
    resp = client.post(
        "/api/v2/bank/rules",
        json={"desc_match_value": "RDC", "target_kind": "nope"},
        headers=headers,
    )
    assert resp.status_code == 422
    assert resp.get_json()["detail"]["field"] == "target_kind"


def test_create_rule_without_any_condition_is_422(client, test_store_id):
    resp = client.post(
        "/api/v2/bank/rules",
        json={"target_kind": "ignore"},
        headers=_login(client, test_store_id),
    )
    assert resp.status_code == 422


def test_apply_rule_endpoint(client, test_store_id):
    from api.Modules.BankSync.Models import BankRule
    with db_session():
        a = _seed_account(test_store_id)
        _seed_txn(test_store_id, a, amount_cents=-4_000, description="COMCAST BUSINESS")
        r = BankRule(store_id=test_store_id, enabled=True, priority=5,
                     desc_match_type="starts_with", desc_match_value="comcast",
                     target_kind="pl_emaginenet_tech", auto_post=True)
        db.session.add(r); db.session.commit()
        rid = r.id
    resp = client.post(f"/api/v2/bank/rules/{rid}/apply",
                       headers=_login(client, test_store_id))
    assert resp.status_code == 200
    assert resp.get_json()["applied"] == {"tagged": 1, "booked": 0, "locked_skipped": 0}


def test_reorder_rewrites_priorities_in_the_given_order(client, test_store_id):
    from api.Modules.BankSync.Models import BankRule
    with db_session():
        ids = []
        for i, word in enumerate(["alpha", "beta", "gamma"]):
            r = BankRule(store_id=test_store_id, enabled=True, priority=(i + 1) * 100,
                         desc_match_type="contains", desc_match_value=word,
                         target_kind="ignore")
            db.session.add(r); db.session.flush(); ids.append(r.id)
        db.session.commit()
    headers = _login(client, test_store_id)
    new_order = [ids[2], ids[0], ids[1]]
    resp = client.post("/api/v2/bank/rules/reorder", json={"ids": new_order},
                       headers=headers)
    assert resp.status_code == 200
    rows = resp.get_json()["rows"]
    assert [r["id"] for r in rows] == new_order
    assert [r["priority"] for r in rows] == [10, 20, 30]
    # A stale / partial list is refused rather than half-applied.
    resp = client.post("/api/v2/bank/rules/reorder", json={"ids": ids[:2]},
                       headers=headers)
    assert resp.status_code == 409


# ── monthly P&L feed ────────────────────────────────────────


def _monthly(client, headers, y, m):
    return client.get(f"/api/v2/monthly/{y}/{m}", headers=headers)


def test_pl_category_feeds_and_locks_its_monthly_column(client, test_store_id):
    from api.Modules.Monthly.Models import MonthlyFinancial
    with db_session():
        a = _seed_account(test_store_id)
        _seed_txn(test_store_id, a, amount_cents=-1_250, description="SQUARE FEES",
                  posted_at=datetime(2026, 5, 3, 9, 0), category_slug="pl_credit_card_fees")
        _seed_txn(test_store_id, a, amount_cents=-2_000, description="SQUARE FEES",
                  posted_at=datetime(2026, 5, 20, 9, 0), category_slug="pl_credit_card_fees")
        _seed_txn(test_store_id, a, amount_cents=-210, description="RDC FEE",
                  posted_at=datetime(2026, 5, 4, 9, 0), category_slug="bank_charge_230")
    headers = _login(client, test_store_id)
    # The operator's typed value for a bank-fed line is ignored…
    resp = client.put("/api/v2/monthly/2026/5",
                      json={"credit_card_fees": 999.0, "money_order_rent": 75.0},
                      headers=headers)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    report = resp.get_json()["report"]
    assert abs(report["credit_card_fees"] - 32.5) < 0.005
    assert abs(report["bank_charges_total"] - 2.10) < 0.005
    # …while a line the bank is silent on keeps the typed value.
    assert abs(report["money_order_rent"] - 75.0) < 0.005
    assert report["bank_locked"] == ["bank_charges_total", "credit_card_fees"]
    with db_session():
        row = db.session.query(MonthlyFinancial).filter_by(
            store_id=test_store_id, year=2026, month=5).one()
        assert abs(row.credit_card_fees - 32.5) < 0.005


def test_monthly_read_shows_live_bank_sum_without_resave(client, test_store_id):
    """Tag a transaction after the last save: the P&L and its totals
    reflect it on the next GET — trust the ledger, never the stored
    value."""
    with db_session():
        a = _seed_account(test_store_id)
    headers = _login(client, test_store_id)
    client.put("/api/v2/monthly/2026/6", json={"other_income_1": 10.0}, headers=headers)
    before = _monthly(client, headers, 2026, 6).get_json()["report"]
    assert before["bank_locked"] == []
    with db_session():
        _seed_txn(test_store_id, a, amount_cents=40_000, description="WU COMMISSION",
                  posted_at=datetime(2026, 6, 10, 9, 0),
                  category_slug="pl_mt_commission_in_bank")
    after = _monthly(client, headers, 2026, 6).get_json()["report"]
    assert abs(after["mt_commission_in_bank"] - 400.0) < 0.005
    assert after["bank_locked"] == ["mt_commission_in_bank"]
    assert abs(after["total_income"] - before["total_income"] - 400.0) < 0.005


def test_month_without_tagged_rows_keeps_manual_entry(client, test_store_id):
    headers = _login(client, test_store_id)
    resp = client.put("/api/v2/monthly/2026/7",
                      json={"credit_card_fees": 12.0, "bank_charges_total": 3.0},
                      headers=headers)
    report = resp.get_json()["report"]
    assert abs(report["credit_card_fees"] - 12.0) < 0.005
    assert abs(report["bank_charges_total"] - 3.0) < 0.005
    assert report["bank_locked"] == []
