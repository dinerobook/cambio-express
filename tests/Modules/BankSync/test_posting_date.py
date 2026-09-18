"""The day a bank row books on is the operator's, not the bank's.

The bank's posting date is when the bank got around to it. A check
deposited Friday afternoon posts Monday morning; a weekend deposit
posts on Monday because the branch was closed. Both belong on the
earlier day's close-out, so:

  * a transaction carries `report_date_override` — the day someone
    chose — and it survives a re-tag, an uncategorize being the only
    thing that clears it;
  * a rule carries `post_date_offset_days` — the recurring version
    of the same thing, since a rule fires on rows nobody has looked
    at yet and can only shift from the bank's date.

These pin the resolution order in `booking_date_for`: this call's
date → the row's stored choice → the bank's date.
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
        store_id=store_id, stripe_account_id=f"fcacc_pd_{store_id}_{last4}",
        institution_name="Bank", last4=last4, enabled=True,
    )
    db.session.add(a); db.session.commit()
    return a.id


_N = [0]


def _seed_txn(store_id, account_id, *, amount_cents=125_000,
              description="REMOTE DEPOSIT 20 CHECKS",
              posted_at=datetime(2026, 5, 6, 10, 0, 0)):
    from api.Modules.BankSync.Models import BankTransaction
    _N[0] += 1
    t = BankTransaction(
        store_id=store_id, stripe_bank_account_id=account_id,
        stripe_transaction_id=f"txn_pd_{_N[0]}",
        amount_cents=amount_cents, description=description,
        category_slug="", posted_at=posted_at, status="posted",
    )
    db.session.add(t); db.session.commit()
    return t.id


def _txn(tid):
    from api.Modules.BankSync.Models import BankTransaction
    return db.session.get(BankTransaction, tid)


def _report(store_id, d):
    from api.Modules.DailyBook.Repositories import find_report_by_date
    return find_report_by_date(db.session, store_id, d)


def _checks_deposit(store_id, d):
    r = _report(store_id, d)
    return float(r.checks_deposit) if r is not None else None


# ── resolution order ────────────────────────────────────────


def test_no_override_books_on_the_banks_date(test_store_id):
    from api.Modules.BankSync.Services import categorize_transaction
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
        categorize_transaction(db.session, _txn(tid), "check_deposit")
        db.session.commit()
        assert _txn(tid).report_date_override is None
        assert abs(_checks_deposit(test_store_id, date(2026, 5, 6)) - 1250.0) < 0.005


def test_a_chosen_day_is_stored_on_the_row(test_store_id):
    from api.Modules.BankSync.Services import categorize_transaction
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
        categorize_transaction(
            db.session, _txn(tid), "check_deposit",
            report_date=date(2026, 5, 5), report_date_explicit=True,
        )
        db.session.commit()
        assert _txn(tid).report_date_override == date(2026, 5, 5)
        assert _report(test_store_id, date(2026, 5, 6)) is None
        assert abs(_checks_deposit(test_store_id, date(2026, 5, 5)) - 1250.0) < 0.005


def test_the_chosen_day_survives_a_recategorize(test_store_id):
    """The regression this column exists for: changing the category
    used to walk the line back to the bank's date, because the
    override was only ever passed, never stored."""
    from api.Modules.BankSync.Services import categorize_transaction
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a, amount_cents=-4_000)
        categorize_transaction(
            db.session, _txn(tid), "cash_expense",
            report_date=date(2026, 5, 5), report_date_explicit=True,
        )
        db.session.commit()
        # A later re-tag that says nothing about the day.
        categorize_transaction(db.session, _txn(tid), "other_cash_out")
        db.session.commit()

        assert _txn(tid).report_date_override == date(2026, 5, 5)
        r = _report(test_store_id, date(2026, 5, 5))
        assert abs(float(r.other_cash_out) - 40.0) < 0.005
        assert abs(float(r.cash_expense)) < 0.005
        assert _report(test_store_id, date(2026, 5, 6)) is None


def test_explicit_null_clears_the_override(test_store_id):
    from api.Modules.BankSync.Services import categorize_transaction
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
        categorize_transaction(
            db.session, _txn(tid), "check_deposit",
            report_date=date(2026, 5, 5), report_date_explicit=True,
        )
        db.session.commit()
        categorize_transaction(
            db.session, _txn(tid), "check_deposit",
            report_date=None, report_date_explicit=True,
        )
        db.session.commit()

        assert _txn(tid).report_date_override is None
        assert abs(_checks_deposit(test_store_id, date(2026, 5, 6)) - 1250.0) < 0.005
        assert abs(_checks_deposit(test_store_id, date(2026, 5, 5))) < 0.005


def test_uncategorize_clears_the_override(test_store_id):
    from api.Modules.BankSync.Services import (
        categorize_transaction, uncategorize_transaction,
    )
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
        categorize_transaction(
            db.session, _txn(tid), "check_deposit",
            report_date=date(2026, 5, 5), report_date_explicit=True,
        )
        db.session.commit()
        uncategorize_transaction(db.session, _txn(tid))
        db.session.commit()

        assert _txn(tid).report_date_override is None
        assert abs(_checks_deposit(test_store_id, date(2026, 5, 5))) < 0.005


def test_a_refused_locked_day_leaves_the_override_untouched(test_store_id):
    """Invariant: the lock is checked before ANY write — the stored
    day included, so a refusal is not half-applied."""
    import pytest
    from api.Modules.DailyBook.Services import lock_report
    from api.Modules.BankSync.Services import (
        DailyBookLockedError, categorize_transaction,
    )
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
        lock_report(db.session, test_store_id, date(2026, 5, 4))
        db.session.commit()
        with pytest.raises(DailyBookLockedError) as exc:
            categorize_transaction(
                db.session, _txn(tid), "check_deposit",
                report_date=date(2026, 5, 4), report_date_explicit=True,
            )
        assert exc.value.report_date == date(2026, 5, 4)
        db.session.rollback()
        assert _txn(tid).report_date_override is None
        assert _txn(tid).category_slug == ""


# ── the endpoint ────────────────────────────────────────────


def test_endpoint_reports_the_chosen_day_and_the_banks_day(client, test_store_id):
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
    headers = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "check_deposit", "report_date": "2026-05-05"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    t = resp.get_json()["transaction"]
    assert t["booked_on"] == "2026-05-05"
    assert t["report_date_override"] == "2026-05-05"
    assert t["bank_date"] == "2026-05-06"

    # The list carries both, so the SPA can offer "use the bank's date".
    row = next(
        r for r in client.get(
            "/api/v2/bank/transactions", headers=headers,
        ).get_json()["rows"] if r["id"] == tid
    )
    assert row["report_date_override"] == "2026-05-05"
    assert row["bank_date"] == "2026-05-06"


def test_endpoint_omitting_report_date_keeps_the_stored_day(client, test_store_id):
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a, amount_cents=-4_000)
    headers = _login(client, test_store_id)
    client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "cash_expense", "report_date": "2026-05-05"},
        headers=headers,
    )
    resp = client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "other_cash_out"}, headers=headers,
    )
    assert resp.status_code == 200
    assert resp.get_json()["transaction"]["booked_on"] == "2026-05-05"


def test_endpoint_null_report_date_returns_to_the_banks_day(client, test_store_id):
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
    headers = _login(client, test_store_id)
    client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "check_deposit", "report_date": "2026-05-05"},
        headers=headers,
    )
    resp = client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "check_deposit", "report_date": None},
        headers=headers,
    )
    assert resp.status_code == 200
    t = resp.get_json()["transaction"]
    assert t["booked_on"] == "2026-05-06"
    assert t["report_date_override"] == ""


def test_audit_summary_records_the_chosen_day(client, test_store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
    client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "check_deposit", "report_date": "2026-05-05"},
        headers=_login(client, test_store_id),
    )
    with db_session():
        row = (
            db.session.query(OperatorAuditLog)
              .filter(OperatorAuditLog.target_id == str(tid))
              .order_by(OperatorAuditLog.id.desc()).first()
        )
        assert "day=2026-05-05" in (row.summary or "")


# ── the rule's day shift ────────────────────────────────────


def _seed_rule(store_id, *, offset=0, target="check_deposit",
               match="REMOTE DEPOSIT"):
    from api.Modules.BankSync.Models import BankRule
    r = BankRule(
        store_id=store_id, enabled=True, priority=10,
        desc_match_type="contains", desc_match_value=match,
        target_kind=target, auto_post=True,
        post_date_offset_days=offset,
    )
    db.session.add(r); db.session.commit()
    return r


def test_rule_offset_books_the_day_before(test_store_id):
    """The operator's case: the bank posts a remote deposit the
    morning after the drawer handed the checks over."""
    from api.Modules.BankSync.Services import apply_rule_to_existing
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
        rule = _seed_rule(test_store_id, offset=-1)
        report = apply_rule_to_existing(db.session, rule)
        db.session.commit()

        assert (report.tagged, report.booked) == (1, 1)
        assert _txn(tid).report_date_override == date(2026, 5, 5)
        assert _report(test_store_id, date(2026, 5, 6)) is None
        assert abs(_checks_deposit(test_store_id, date(2026, 5, 5)) - 1250.0) < 0.005


def test_rule_without_an_offset_books_on_the_banks_day(test_store_id):
    from api.Modules.BankSync.Services import apply_rule_to_existing
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
        apply_rule_to_existing(db.session, _seed_rule(test_store_id, offset=0))
        db.session.commit()

        assert _txn(tid).report_date_override is None
        assert abs(_checks_deposit(test_store_id, date(2026, 5, 6)) - 1250.0) < 0.005


def test_rule_offset_is_remembered_when_the_shifted_day_is_locked(test_store_id):
    """A closed day still keeps the tag and the day the rule meant,
    so unlocking and re-tagging lands where the operator intended
    rather than on the bank's date."""
    from api.Modules.DailyBook.Services import lock_report
    from api.Modules.BankSync.Services import apply_rule_to_existing
    with db_session():
        a = _seed_account(test_store_id)
        tid = _seed_txn(test_store_id, a)
        lock_report(db.session, test_store_id, date(2026, 5, 5))
        db.session.commit()
        report = apply_rule_to_existing(
            db.session, _seed_rule(test_store_id, offset=-1),
        )
        db.session.commit()

        assert (report.tagged, report.booked, report.locked_skipped) == (1, 0, 1)
        t = _txn(tid)
        assert t.category_slug == "check_deposit"
        assert t.daily_line_item_id is None
        assert t.report_date_override == date(2026, 5, 5)


def test_rule_offset_round_trips_through_the_endpoint(client, test_store_id):
    headers = _login(client, test_store_id)
    resp = client.post(
        "/api/v2/bank/rules",
        json={
            "desc_match_type": "contains",
            "desc_match_value": "REMOTE DEPOSIT",
            "target_kind": "check_deposit",
            "auto_post": True,
            "post_date_offset_days": -1,
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.get_data(as_text=True)
    rule = resp.get_json()["rule"]
    assert rule["post_date_offset_days"] == -1

    rows = client.get("/api/v2/bank/rules", headers=headers).get_json()["rows"]
    assert next(r for r in rows if r["id"] == rule["id"])["post_date_offset_days"] == -1

    edited = client.put(
        f"/api/v2/bank/rules/{rule['id']}",
        json={
            "desc_match_type": "contains",
            "desc_match_value": "REMOTE DEPOSIT",
            "target_kind": "check_deposit",
            "auto_post": True,
            "post_date_offset_days": 0,
        },
        headers=headers,
    )
    assert edited.status_code == 200
    assert edited.get_json()["rule"]["post_date_offset_days"] == 0


def test_rule_offset_out_of_range_is_422(client, test_store_id):
    resp = client.post(
        "/api/v2/bank/rules",
        json={
            "desc_match_type": "contains",
            "desc_match_value": "REMOTE DEPOSIT",
            "target_kind": "check_deposit",
            "post_date_offset_days": 400,
        },
        headers=_login(client, test_store_id),
    )
    assert resp.status_code == 422
