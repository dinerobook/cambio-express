"""Bank transactions matched to daily book entries (owner, 2026-10-21).

The bug this closes: the cashier types Monday's check deposit, the
bank reports it days later, and a rule (or a tag on the Bank page)
booked the same money a second time. With the store's
``bank_matching`` switch on, the bank row is linked to the typed
entry instead. Pinned here (BankSync INVARIANTS.md "Matching"):

  * switch off = exactly the old behaviour;
  * sure match links, nothing booked; possible match books nothing
    and waits; no match books as before;
  * windows, direction, kind, check numbers, same-day sums, rivals;
  * a locked day does not stop a link (no money moves);
  * the typed entry arriving after the bank row, entry deleted or
    its amount changed;
  * "No" is remembered, unmatch, dismiss / restore (admin right,
    grantable), the in-twice list and "keep the typed entry";
  * every new route: grant, deny, switch off;
  * the daily book's "In bank" mark;
  * the Stripe webhook sync and the sync look-back window;
  * migration and retention purge.
"""
import importlib.util
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee


BANK = "/api/v2/bank"
MON = date(2026, 5, 4)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def admin(client, test_store_id):
    return _h(login_admin(client, test_store_id))


def _switch_on(store_id, on=True):
    from api.Modules.Billing.Models import StoreFeatureOverride
    with db_session():
        row = (db.session.query(StoreFeatureOverride)
               .filter_by(store_id=store_id, flag_key="bank_matching").first())
        if row is None:
            row = StoreFeatureOverride(store_id=store_id, flag_key="bank_matching",
                                       enabled=on)
            db.session.add(row)
        row.enabled = on
        db.session.commit()


@pytest.fixture
def on(test_store_id):
    _switch_on(test_store_id)
    return test_store_id


_N = [0]


def _account(store_id, last4="0230"):
    from api.Modules.BankSync.Models import StripeBankAccount
    with db_session():
        a = StripeBankAccount(store_id=store_id, stripe_account_id=f"fcacc_m_{last4}_{store_id}",
                              institution_name="Bank", last4=last4, enabled=True)
        db.session.add(a)
        db.session.commit()
        return a.id


def _txn(store_id, acct, cents, day, *, slug="", desc="DEPOSIT"):
    from api.Modules.BankSync.Models import BankTransaction
    _N[0] += 1
    with db_session():
        t = BankTransaction(
            store_id=store_id, stripe_bank_account_id=acct,
            stripe_transaction_id=f"txn_m_{_N[0]}", amount_cents=cents,
            description=desc, category_slug=slug, status="posted",
            posted_at=datetime.combine(day, datetime.min.time()) + timedelta(hours=10),
        )
        db.session.add(t)
        db.session.commit()
        return t.id


def _line(store_id, kind, amount, day, note=""):
    from api.Modules.DailyBook.Services import LINE_ITEM_KINDS
    from api.Modules.DailyBook.Services.line_items import (
        add_line_item, recompute_line_items_total,
    )
    with db_session():
        row = add_line_item(db.session, store_id=store_id, report_date=day,
                            kind=kind, at_time=None, amount=amount, note=note,
                            settles_item_id=None)
        recompute_line_items_total(db.session, store_id, day, kind=kind,
                                   daily_report_field=LINE_ITEM_KINDS[kind][0])
        db.session.commit()
        return row.id


def _get(model, pk):
    return db.session.get(model, pk)


def _categorize(tid, slug, **kw):
    from api.Modules.BankSync.Models import BankTransaction
    from api.Modules.BankSync.Services import categorize_transaction
    with db_session():
        txn = _get(BankTransaction, tid)
        categorize_transaction(db.session, txn, slug, **kw)
        db.session.commit()
        return txn.daily_line_item_id


def _matched_ids(tid):
    from api.Modules.BankSync.Models import BankTransaction
    from api.Modules.BankSync.Services.reconcile import matched_lines
    with db_session():
        return [l.id for l in matched_lines(db.session, _get(BankTransaction, tid))]


def _lines(store_id, kind):
    from api.Modules.DailyBook.Models import DailyLineItem
    with db_session():
        return (db.session.query(DailyLineItem)
                .filter_by(store_id=store_id, kind=kind).count())


def _checks_deposit(store_id, day):
    from api.Modules.DailyBook.Repositories import find_report_by_date
    with db_session():
        r = find_report_by_date(db.session, store_id, day)
        return float(r.checks_deposit or 0) if r else 0.0


# ── the switch ──────────────────────────────────────────────


def test_switch_off_books_exactly_as_before(test_store_id):
    """Off (the default for every store): the bank row still books
    a second entry. Nothing changes until a store is switched on."""
    a = _account(test_store_id)
    _line(test_store_id, "check_deposit", 1234.00, MON)
    tid = _txn(test_store_id, a, 123_400, MON + timedelta(days=2))
    assert _categorize(tid, "check_deposit") is not None
    assert _lines(test_store_id, "check_deposit") == 2
    assert _matched_ids(tid) == []


def test_switch_reads_off_with_no_registry_row(test_store_id):
    from api.Modules.BankSync.Services.reconcile import matching_enabled
    with db_session():
        assert matching_enabled(db.session, test_store_id) is False
    _switch_on(test_store_id)
    with db_session():
        assert matching_enabled(db.session, test_store_id) is True


# ── tiers ───────────────────────────────────────────────────


def test_late_bank_row_links_to_the_typed_entry_and_books_nothing(on):
    a = _account(on)
    lid = _line(on, "check_deposit", 1234.00, MON)
    tid = _txn(on, a, 123_400, MON + timedelta(days=10 - 3))
    assert _categorize(tid, "check_deposit") is None
    assert _matched_ids(tid) == [lid]
    assert _lines(on, "check_deposit") == 1
    assert abs(_checks_deposit(on, MON) - 1234.0) < 0.005


def test_rule_on_fresh_sync_row_links_instead_of_posting(on):
    from api.Modules.BankSync.Models import BankRule, BankTransaction
    from api.Modules.BankSync.Services import apply_rules_to_uncategorized_row
    a = _account(on)
    lid = _line(on, "check_deposit", 500.00, MON)
    tid = _txn(on, a, 50_000, MON + timedelta(days=1), desc="REMOTE DEPOSIT")
    with db_session():
        db.session.add(BankRule(store_id=on, enabled=True, priority=10,
                                desc_match_type="contains",
                                desc_match_value="REMOTE DEPOSIT",
                                target_kind="check_deposit", auto_post=True))
        db.session.commit()
        txn = _get(BankTransaction, tid)
        assert apply_rules_to_uncategorized_row(db.session, txn, None,
                                                allow_auto_post=True)
        db.session.commit()
        assert txn.category_slug == "check_deposit"
        assert txn.daily_line_item_id is None
    assert _matched_ids(tid) == [lid]
    assert _lines(on, "check_deposit") == 1


def test_locked_day_still_links(on):
    """The 10-days-late case: the day is closed by now. A link moves
    no money, so it is allowed; the rule reports no locked skip."""
    from api.Modules.BankSync.Models import BankRule, BankTransaction
    from api.Modules.BankSync.Services import apply_rule_to_existing
    from api.Modules.DailyBook.Services import lock_report
    a = _account(on)
    lid = _line(on, "check_deposit", 800.00, MON)
    with db_session():
        lock_report(db.session, on, MON)
        db.session.commit()
    tid = _txn(on, a, 80_000, MON + timedelta(days=6), desc="DEP")
    with db_session():
        rule = BankRule(store_id=on, enabled=True, priority=10,
                        desc_match_type="contains", desc_match_value="DEP",
                        target_kind="check_deposit", auto_post=True,
                        post_date_offset_days=-6)
        db.session.add(rule)
        db.session.commit()
        rep = apply_rule_to_existing(db.session, rule)
        db.session.commit()
        assert (rep.tagged, rep.booked, rep.locked_skipped, rep.matched) == (1, 0, 0, 1)
        assert _get(BankTransaction, tid).daily_line_item_id is None
    assert _matched_ids(tid) == [lid]


def test_no_entry_books_as_before(on):
    a = _account(on)
    tid = _txn(on, a, 70_000, MON)
    assert _categorize(tid, "check_deposit") is not None
    assert _matched_ids(tid) == []


def test_two_possible_entries_book_nothing_and_wait(on):
    a = _account(on)
    _line(on, "check_deposit", 500.00, MON)
    _line(on, "check_deposit", 500.00, MON + timedelta(days=1))
    tid = _txn(on, a, 50_000, MON + timedelta(days=2))
    assert _categorize(tid, "check_deposit") is None
    assert _matched_ids(tid) == []
    assert _lines(on, "check_deposit") == 2


def test_a_rival_bank_row_makes_it_a_suggestion(on):
    a = _account(on)
    _line(on, "check_deposit", 500.00, MON)
    _txn(on, a, 50_000, MON + timedelta(days=1))  # untagged rival
    tid = _txn(on, a, 50_000, MON + timedelta(days=2))
    assert _categorize(tid, "check_deposit") is None
    assert _matched_ids(tid) == []


def test_check_number_settles_between_two_candidates(on):
    a = _account(on)
    _line(on, "check_expense", 250.00, MON, note="Rent ck 1041")
    lid = _line(on, "check_expense", 250.00, MON, note="Supplies ck 1042")
    tid = _txn(on, a, -25_000, MON + timedelta(days=20), desc="CHECK 1042")
    assert _categorize(tid, "check_expense") is None
    assert _matched_ids(tid) == [lid]


def test_written_check_clears_within_ninety_days_only(on):
    a = _account(on)
    lid = _line(on, "check_payroll" if False else "payroll_check", 900.00, MON)
    late = _txn(on, a, -90_000, MON + timedelta(days=91))
    assert _categorize(late, "payroll_check") is not None   # too late: books
    ok = _txn(on, a, -90_000, MON + timedelta(days=89))
    assert _categorize(ok, "payroll_check") is None
    assert _matched_ids(ok) == [lid]


def test_deposit_window_is_one_day_before_to_seven_after(on):
    a = _account(on)
    _line(on, "drop", 300.00, MON)
    too_late = _txn(on, a, 30_000, MON + timedelta(days=8))
    assert _categorize(too_late, "drop") is not None
    lid = _line(on, "drop", 310.00, MON)
    day_before = _txn(on, a, 31_000, MON - timedelta(days=1))
    assert _categorize(day_before, "drop") is None
    assert _matched_ids(day_before) == [lid]


def test_wrong_direction_never_matches(on):
    a = _account(on)
    _line(on, "check_deposit", 400.00, MON)
    tid = _txn(on, a, -40_000, MON)
    # A debit tagged as a deposit is not this deposit.
    assert _categorize(tid, "check_deposit") is not None
    assert _matched_ids(tid) == []


def test_cash_kinds_never_match(on):
    a = _account(on)
    _line(on, "cash_expense", 40.00, MON)
    tid = _txn(on, a, -4_000, MON)
    assert _categorize(tid, "cash_expense") is not None
    assert _lines(on, "cash_expense") == 2


def test_same_day_entries_adding_up_are_suggested_not_linked(on):
    a = _account(on)
    _line(on, "check_deposit", 300.00, MON)
    _line(on, "check_deposit", 200.00, MON)
    tid = _txn(on, a, 50_000, MON + timedelta(days=1))
    assert _categorize(tid, "check_deposit") is None
    assert _matched_ids(tid) == []


def test_held_check_deposit_matches_its_bank_tag(on):
    a = _account(on)
    lid = _line(on, "check_hold", 600.00, MON)
    from api.Modules.DailyBook.Services.line_items import add_line_item
    with db_session():
        dep = add_line_item(db.session, store_id=on, report_date=MON + timedelta(days=3),
                            kind="held_check_deposit", at_time=None, amount=600.00,
                            settles_item_id=lid)
        db.session.commit()
        dep_id = dep.id
    tid = _txn(on, a, 60_000, MON + timedelta(days=4))
    _categorize(tid, "held_checks_deposited")
    assert _matched_ids(tid) == [dep_id]


# ── entries changing after the bank row ─────────────────────


def test_typing_the_entry_after_the_bank_row_links_it(client, on, admin):
    from api.Modules.BankSync.Models import BankTransaction
    a = _account(on)
    tid = _txn(on, a, 77_700, MON + timedelta(days=2))
    _categorize(tid, "check_deposit", post_to_daily=False)
    resp = client.post(f"/api/v2/daily/{on}/{MON.isoformat()}/line-items",
                       json={"kind": "check_deposit", "amount": 777.00}, headers=admin)
    assert resp.status_code == 201
    assert _matched_ids(tid) == [resp.get_json()["id"]]
    with db_session():
        assert _get(BankTransaction, tid).daily_line_item_id is None
    items = client.get(f"/api/v2/daily/{on}/{MON.isoformat()}/line-items",
                       headers=admin).get_json()["items"]
    assert items[0]["in_bank"] == "matched"
    assert items[0]["bank_date"] == (MON + timedelta(days=2)).isoformat()


def test_deleting_a_matched_entry_frees_the_bank_row(client, on, admin):
    a = _account(on)
    lid = _line(on, "check_deposit", 450.00, MON)
    tid = _txn(on, a, 45_000, MON + timedelta(days=1))
    _categorize(tid, "check_deposit")
    assert _matched_ids(tid) == [lid]
    assert client.delete(f"/api/v2/daily/{on}/line-items/{lid}",
                         headers=admin).status_code == 204
    assert _matched_ids(tid) == []
    row = client.get(f"{BANK}/transactions", headers=admin).get_json()["rows"][0]
    assert row["books_status"] == "not_on_books"


def test_changing_a_matched_entrys_amount_unlinks_it(client, on, admin):
    a = _account(on)
    lid = _line(on, "check_deposit", 450.00, MON)
    tid = _txn(on, a, 45_000, MON + timedelta(days=1))
    _categorize(tid, "check_deposit")
    resp = client.patch(f"/api/v2/daily/{on}/line-items/{lid}",
                        json={"amount": 455.0}, headers=admin)
    assert resp.status_code == 200
    assert _matched_ids(tid) == []
    # A note change keeps the match.
    lid2 = _line(on, "check_deposit", 460.00, MON)
    t2 = _txn(on, a, 46_000, MON + timedelta(days=1))
    _categorize(t2, "check_deposit")
    client.patch(f"/api/v2/daily/{on}/line-items/{lid2}", json={"note": "am"},
                 headers=admin)
    assert _matched_ids(t2) == [lid2]


def test_retagging_drops_the_match(on):
    a = _account(on)
    _line(on, "check_deposit", 300.00, MON)
    tid = _txn(on, a, 30_000, MON)
    _categorize(tid, "check_deposit")
    assert _matched_ids(tid)
    _categorize(tid, "pl_credit_card_fees")
    assert _matched_ids(tid) == []


# ── the Bank page ───────────────────────────────────────────


def test_list_shows_status_and_counts_only_with_switch_on(client, test_store_id, admin):
    a = _account(test_store_id)
    lid = _line(test_store_id, "check_deposit", 300.00, MON)
    tid = _txn(test_store_id, a, 30_000, MON + timedelta(days=1))
    _switch_on(test_store_id)
    _categorize(tid, "check_deposit")
    _txn(test_store_id, a, 99_00, MON, slug="")  # untagged, no candidate
    body = client.get(f"{BANK}/transactions", headers=admin).get_json()
    assert body["matching_enabled"] is True
    rows = {r["id"]: r for r in body["rows"]}
    assert rows[tid]["books_status"] == "matched"
    assert rows[tid]["matched_entries"][0]["id"] == lid
    assert rows[tid]["matched_entries"][0]["kind_label"] == "Check deposit"
    assert body["books_counts"] == {"added": 0, "matched": 1, "to_review": 1, "dismissed": 0}
    review = client.get(f"{BANK}/transactions?books=review", headers=admin).get_json()
    assert [r["id"] for r in review["rows"]] != [tid] and review["total"] == 1
    _switch_on(test_store_id, False)
    body = client.get(f"{BANK}/transactions", headers=admin).get_json()
    assert body["matching_enabled"] is False
    assert all(r["books_status"] == "" for r in body["rows"])


def test_suggested_row_lists_candidates_and_confirms(client, on, admin):
    a = _account(on)
    l1 = _line(on, "check_deposit", 500.00, MON)
    _line(on, "check_deposit", 500.00, MON + timedelta(days=1))
    tid = _txn(on, a, 50_000, MON + timedelta(days=2))
    _categorize(tid, "check_deposit")
    rows = client.get(f"{BANK}/transactions", headers=admin).get_json()["rows"]
    assert rows[0]["books_status"] == "suggested"
    assert rows[0]["suggestion_count"] == 2
    cands = client.get(f"{BANK}/transactions/{tid}/candidates",
                       headers=admin).get_json()["candidates"]
    # Closest day first.
    assert cands[0]["days_from_bank"] == 1
    assert {c["line_ids"][0] for c in cands} == {l1, cands[0]["line_ids"][0]}
    resp = client.post(f"{BANK}/transactions/{tid}/match",
                       json={"line_ids": [l1]}, headers=admin)
    assert resp.status_code == 200
    assert resp.get_json()["transaction"]["books_status"] == "matched"
    assert _matched_ids(tid) == [l1]


def test_match_by_hand_tags_an_untagged_row(client, on, admin):
    from api.Modules.BankSync.Models import BankTransaction
    a = _account(on)
    lid = _line(on, "from_bank", 200.00, MON)
    tid = _txn(on, a, -20_000, MON)
    resp = client.post(f"{BANK}/transactions/{tid}/match",
                       json={"line_ids": [lid]}, headers=admin)
    assert resp.status_code == 200
    with db_session():
        t = _get(BankTransaction, tid)
        assert t.category_slug == "from_bank"
        assert t.daily_line_item_id is None


def test_match_validation(client, on, admin):
    a = _account(on)
    lid = _line(on, "check_deposit", 100.00, MON)
    cash = _line(on, "cash_expense", 100.00, MON)
    tid = _txn(on, a, 20_000, MON)
    url = f"{BANK}/transactions/{tid}/match"
    assert client.post(url, json={"line_ids": [lid]}, headers=admin).status_code == 422
    assert client.post(url, json={"line_ids": [cash]}, headers=admin).status_code == 422
    assert client.post(url, json={"line_ids": [999_999]}, headers=admin).status_code == 404
    two = _line(on, "check_deposit", 100.00, MON)
    assert client.post(url, json={"line_ids": [lid, two]}, headers=admin).status_code == 200
    # Taken by that row now: another bank row can't claim it.
    other = _txn(on, a, 10_000, MON)
    resp = client.post(f"{BANK}/transactions/{other}/match",
                       json={"line_ids": [lid]}, headers=admin)
    assert resp.status_code == 409 and resp.get_json()["detail"]["code"] == "entry_taken"
    # Already matched: unmatch first.
    resp = client.post(url, json={"line_ids": [lid]}, headers=admin)
    assert resp.status_code == 409


def test_reject_is_remembered(client, on, admin):
    from api.Modules.BankSync.Services.reconcile import reconcile_store
    a = _account(on)
    lid = _line(on, "check_deposit", 500.00, MON)
    _line(on, "check_deposit", 500.00, MON)
    tid = _txn(on, a, 50_000, MON + timedelta(days=1))
    _categorize(tid, "check_deposit")
    assert client.post(f"{BANK}/transactions/{tid}/reject", json={"line_ids": [lid]},
                       headers=admin).status_code == 200
    cands = client.get(f"{BANK}/transactions/{tid}/candidates",
                       headers=admin).get_json()["candidates"]
    assert lid not in [c["line_ids"][0] for c in cands]
    # Only the other one fits now — it is a sure match on the next pass.
    with db_session():
        assert reconcile_store(db.session, on) == 1
        db.session.commit()
    assert _matched_ids(tid) != [lid] and len(_matched_ids(tid)) == 1


def test_unmatch_keeps_the_entry_and_does_not_rematch(client, on, admin):
    from api.Modules.BankSync.Services.reconcile import reconcile_store
    a = _account(on)
    lid = _line(on, "check_deposit", 300.00, MON)
    tid = _txn(on, a, 30_000, MON)
    _categorize(tid, "check_deposit")
    resp = client.post(f"{BANK}/transactions/{tid}/unmatch", headers=admin)
    assert resp.status_code == 200
    assert resp.get_json()["transaction"]["books_status"] == "not_on_books"
    assert _lines(on, "check_deposit") == 1
    with db_session():
        assert reconcile_store(db.session, on) == 0
    assert client.post(f"{BANK}/transactions/{tid}/unmatch",
                       headers=admin).status_code == 409
    assert lid


def test_match_works_on_a_locked_day(client, on, admin):
    from api.Modules.DailyBook.Services import lock_report
    a = _account(on)
    lid = _line(on, "check_deposit", 500.00, MON)
    _line(on, "check_deposit", 500.00, MON)
    with db_session():
        lock_report(db.session, on, MON)
        db.session.commit()
    tid = _txn(on, a, 50_000, MON + timedelta(days=1))
    assert client.post(f"{BANK}/transactions/{tid}/match", json={"line_ids": [lid]},
                       headers=admin).status_code == 200
    assert client.post(f"{BANK}/transactions/{tid}/unmatch",
                       headers=admin).status_code == 200


# ── in twice ────────────────────────────────────────────────


def test_doubles_list_and_keep_the_typed_entry(client, test_store_id, admin):
    """Before the switch: the bank added an entry the cashier had
    typed too. The list shows it; "keep typed" removes the bank's."""
    a = _account(test_store_id)
    typed = _line(test_store_id, "check_deposit", 640.00, MON)
    tid = _txn(test_store_id, a, 64_000, MON + timedelta(days=1))
    _categorize(tid, "check_deposit")   # switch off: booked twice
    assert abs(_checks_deposit(test_store_id, MON) - 640.0) < 0.005
    assert abs(_checks_deposit(test_store_id, MON + timedelta(days=1)) - 640.0) < 0.005
    _switch_on(test_store_id)
    rows = client.get(f"{BANK}/reconcile/doubles", headers=admin).get_json()["rows"]
    assert len(rows) == 1 and rows[0]["typed_entry"]["id"] == typed
    resp = client.post(f"{BANK}/transactions/{tid}/use-entry",
                       json={"line_id": typed}, headers=admin)
    assert resp.status_code == 200
    assert resp.get_json()["transaction"]["books_status"] == "matched"
    assert _checks_deposit(test_store_id, MON + timedelta(days=1)) == 0
    assert _lines(test_store_id, "check_deposit") == 1
    assert client.get(f"{BANK}/reconcile/doubles", headers=admin).get_json()["rows"] == []


def test_not_a_double_is_remembered(client, test_store_id, admin):
    a = _account(test_store_id)
    typed = _line(test_store_id, "check_deposit", 640.00, MON)
    tid = _txn(test_store_id, a, 64_000, MON + timedelta(days=1))
    _categorize(tid, "check_deposit")
    _switch_on(test_store_id)
    assert client.post(f"{BANK}/transactions/{tid}/reject", json={"line_ids": [typed]},
                       headers=admin).status_code == 200
    assert client.get(f"{BANK}/reconcile/doubles", headers=admin).get_json()["rows"] == []


def test_keep_typed_on_a_locked_day_is_409(client, test_store_id, admin):
    from api.Modules.DailyBook.Services import lock_report
    a = _account(test_store_id)
    typed = _line(test_store_id, "check_deposit", 640.00, MON)
    tid = _txn(test_store_id, a, 64_000, MON + timedelta(days=1))
    _categorize(tid, "check_deposit")
    with db_session():
        lock_report(db.session, test_store_id, MON + timedelta(days=1))
        db.session.commit()
    _switch_on(test_store_id)
    resp = client.post(f"{BANK}/transactions/{tid}/use-entry",
                       json={"line_id": typed}, headers=admin)
    assert resp.status_code == 409
    assert resp.get_json()["detail"]["code"] == "daily_book_locked"
    assert _lines(test_store_id, "check_deposit") == 2


# ── dismiss ─────────────────────────────────────────────────


def test_dismiss_ticked_and_restore(client, on, admin):
    from api.Modules.BankSync.Models import BankTransaction
    a = _account(on)
    t1 = _txn(on, a, 12_300, MON)
    t2 = _txn(on, a, 45_600, MON)
    booked = _txn(on, a, 78_900, MON)
    _categorize(booked, "check_deposit")
    resp = client.post(f"{BANK}/transactions/dismiss",
                       json={"ids": [t1, booked]}, headers=admin)
    assert resp.get_json() == {"dismissed": 1, "skipped": 1}
    rows = {r["id"]: r for r in
            client.get(f"{BANK}/transactions", headers=admin).get_json()["rows"]}
    assert rows[t1]["books_status"] == "dismissed" and rows[t1]["dismissed_at"]
    assert rows[t2]["books_status"] != "dismissed"
    # A dismissed row can't be tagged until restored.
    resp = client.post(f"{BANK}/transactions/{t1}/categorize",
                       json={"target_kind": "check_deposit"}, headers=admin)
    assert resp.status_code == 409
    assert resp.get_json()["detail"]["code"] == "transaction_dismissed"
    resp = client.post(f"{BANK}/transactions/{t1}/restore", headers=admin)
    assert resp.status_code == 200
    with db_session():
        assert _get(BankTransaction, t1).dismissed_at is None
    assert client.post(f"{BANK}/transactions/{t1}/restore",
                       headers=admin).status_code == 409


def test_dismiss_everything_before_a_date(client, on, admin):
    a = _account(on)
    old = _txn(on, a, 1_000, MON - timedelta(days=30))
    _txn(on, a, 2_000, MON + timedelta(days=1))
    resp = client.post(f"{BANK}/transactions/dismiss",
                       json={"before": MON.isoformat()}, headers=admin)
    assert resp.get_json() == {"dismissed": 1, "skipped": 0}
    dismissed = client.get(f"{BANK}/transactions?books=dismissed",
                           headers=admin).get_json()["rows"]
    assert [r["id"] for r in dismissed] == [old]
    assert client.post(f"{BANK}/transactions/dismiss", json={}, headers=admin).status_code == 422
    assert client.post(f"{BANK}/transactions/dismiss",
                       json={"ids": [old], "before": MON.isoformat()},
                       headers=admin).status_code == 422


def test_rules_leave_dismissed_rows_alone(on):
    from api.Modules.BankSync.Models import BankRule, BankTransaction
    from api.Modules.BankSync.Services import apply_rule_to_existing
    a = _account(on)
    tid = _txn(on, a, 5_000, MON, desc="FEE")
    with db_session():
        t = _get(BankTransaction, tid)
        t.dismissed_at = datetime(2026, 5, 5)
        rule = BankRule(store_id=on, enabled=True, priority=1,
                        desc_match_type="contains", desc_match_value="FEE",
                        target_kind="check_deposit", auto_post=True)
        db.session.add(rule)
        db.session.commit()
        assert apply_rule_to_existing(db.session, rule).tagged == 0
        assert _get(BankTransaction, tid).category_slug == ""


# ── access ──────────────────────────────────────────────────


def _employee(client, sid, username, matrix):
    from api.Core.Permissions import set_user_permissions
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=sid, username=username, role="employee", is_active=True)
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()
        uid = u.id
    set_user_permissions(sid, uid, matrix)
    return _h(login_employee(client, sid, username, "emppass1234")), uid


def test_matching_routes_need_bank_rights(client, on):
    a = _account(on)
    lid = _line(on, "check_deposit", 100.00, MON)
    tid = _txn(on, a, 10_000, MON)
    nobody, _ = _employee(client, on, "m_none", {"time_clock": {"read": True}})
    reader, _ = _employee(client, on, "m_read", {"bank_sync": {"read": True}})
    assert client.get(f"{BANK}/transactions/{tid}/candidates",
                      headers=nobody).status_code == 403
    assert client.get(f"{BANK}/transactions/{tid}/candidates",
                      headers=reader).status_code == 200
    assert client.get(f"{BANK}/reconcile/doubles", headers=reader).status_code == 200
    for path, body in (
        (f"/transactions/{tid}/match", {"line_ids": [lid]}),
        (f"/transactions/{tid}/reject", {"line_ids": [lid]}),
        (f"/transactions/{tid}/unmatch", None),
        ("/reconcile/run", None),
    ):
        assert client.post(BANK + path, json=body, headers=reader).status_code == 403


def test_dismiss_is_admin_only_unless_granted_and_revocable(client, on):
    from api.Core.Permissions import set_user_permissions
    a = _account(on)
    tid = _txn(on, a, 10_000, MON)
    full_bank = {"bank_sync": {k: True for k in ("create", "read", "update", "delete")}}
    emp, uid = _employee(client, on, "m_dismiss", full_bank)
    url = f"{BANK}/transactions/dismiss"
    assert client.post(url, json={"ids": [tid]}, headers=emp).status_code == 403
    assert client.post(f"{BANK}/transactions/{tid}/restore", headers=emp).status_code == 403
    set_user_permissions(on, uid, {**full_bank, "bank_dismiss": {"update": True}})
    assert client.post(url, json={"ids": [tid]}, headers=emp).status_code == 200
    assert client.post(f"{BANK}/transactions/{tid}/restore", headers=emp).status_code == 200
    set_user_permissions(on, uid, full_bank)
    assert client.post(url, json={"ids": [tid]}, headers=emp).status_code == 403


def test_employee_defaults_do_not_include_dismiss():
    from api.Core.Permissions import RBAC_DEFAULTS
    assert "bank_dismiss.update" in RBAC_DEFAULTS["admin"]
    assert "bank_dismiss.update" not in RBAC_DEFAULTS["employee"]
    assert "bank_dismiss.update" not in RBAC_DEFAULTS["owner"]


def test_routes_refuse_with_the_switch_off(client, test_store_id, admin):
    a = _account(test_store_id)
    tid = _txn(test_store_id, a, 10_000, MON)
    for method, path, body in (
        ("get", f"/transactions/{tid}/candidates", None),
        ("post", f"/transactions/{tid}/match", {"line_ids": [1]}),
        ("post", f"/transactions/{tid}/reject", {"line_ids": [1]}),
        ("post", f"/transactions/{tid}/unmatch", None),
        ("post", f"/transactions/{tid}/restore", None),
        ("post", f"/transactions/{tid}/use-entry", {"line_id": 1}),
        ("post", "/transactions/dismiss", {"ids": [tid]}),
        ("get", "/reconcile/doubles", None),
        ("post", "/reconcile/run", None),
    ):
        fn = getattr(client, method)
        resp = fn(BANK + path, headers=admin) if body is None and method == "get" \
            else fn(BANK + path, json=body, headers=admin)
        assert resp.status_code == 403, path
        assert resp.get_json()["detail"]["code"] == "matching_off"


def test_another_stores_rows_and_entries_are_404(client, on, admin):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other", slug="other-m", plan="trial")
        db.session.add(other)
        db.session.commit()
        oid = other.id
    oa = _account(oid, "9999")
    otxn = _txn(oid, oa, 10_000, MON)
    oline = _line(oid, "check_deposit", 100.00, MON)
    a = _account(on)
    tid = _txn(on, a, 10_000, MON)
    assert client.get(f"{BANK}/transactions/{otxn}/candidates",
                      headers=admin).status_code == 404
    assert client.post(f"{BANK}/transactions/{tid}/match", json={"line_ids": [oline]},
                       headers=admin).status_code == 404


def test_match_now_runs_the_pass_and_is_audited(client, on, admin):
    from api.Modules.Audit.Models import OperatorAuditLog
    a = _account(on)
    tid = _txn(on, a, 30_000, MON)
    _categorize(tid, "check_deposit", post_to_daily=False)
    _line(on, "check_deposit", 300.00, MON)  # typed outside the API: no hook
    resp = client.post(f"{BANK}/reconcile/run", headers=admin)
    assert resp.get_json() == {"matched": 1}
    with db_session():
        assert db.session.query(OperatorAuditLog).filter_by(
            store_id=on, action="reconcile_bank").count() == 1


# ── sync ────────────────────────────────────────────────────


def test_lookback_reaches_back_thirty_days_and_over_a_gap():
    from api.Modules.BankSync.Services.sync import lookback_start
    now = datetime(2026, 6, 30, 12)
    with db_session():
        acct_id = 987_654   # no rows: plain 30 days
        assert lookback_start(db.session, acct_id, now) == now - timedelta(days=30)


def test_lookback_extends_to_the_newest_row_capped_at_ninety(test_store_id):
    from api.Modules.BankSync.Services.sync import lookback_start
    a = _account(test_store_id)
    now = datetime(2026, 6, 30, 12)
    _txn(test_store_id, a, 100, date(2026, 5, 1))
    with db_session():
        lo = lookback_start(db.session, a, now)
        assert lo.date() == date(2026, 4, 30)
    _txn(test_store_id, a, 100, date(2026, 1, 1))
    b = _account(test_store_id, "1111")
    _txn(test_store_id, b, 100, date(2026, 1, 1))
    with db_session():
        assert lookback_start(db.session, b, now) == now - timedelta(days=90)


def test_webhook_syncs_the_refreshed_account_without_refreshing_again(
    test_store_id, monkeypatch,
):
    from api.Modules.Billing.Services.webhook import handle_stripe_event
    import api.Modules.BankSync.Services.sync as sync_mod
    a = _account(test_store_id)
    calls = []

    def fake(db_, store, since=None, until=None, *, account_ids=None, refresh=True):
        calls.append((store.id, account_ids, refresh))
        return 0, 0, ""

    monkeypatch.setattr(sync_mod, "sync_bank_transactions", fake)
    event = {"type": "financial_connections.account.refreshed_transactions",
             "data": {"object": {"id": f"fcacc_m_0230_{test_store_id}"}}}
    with db_session():
        handle_stripe_event(db.session, event)
        assert calls == [(test_store_id, [a], False)]
        handle_stripe_event(db.session, {
            "type": "financial_connections.account.refreshed_transactions",
            "data": {"object": {"id": "fcacc_unknown"}}})
        assert len(calls) == 1


# ── schema ──────────────────────────────────────────────────

_MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "alembic" / "versions" / "a7d3e9c1b5f4_bank_daily_match.py"
)


def test_migration_matches_the_model_and_is_additive():
    import sqlalchemy as sa_
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from api.Modules.BankSync.Models import BankDailyMatch, BankTransaction

    spec = importlib.util.spec_from_file_location("bdm_migration", _MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = sa_.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE tenancy_user (id INTEGER PRIMARY KEY)")
        conn.exec_driver_sql("CREATE TABLE tenancy_store (id INTEGER PRIMARY KEY)")
        conn.exec_driver_sql(
            "CREATE TABLE bank_transaction (id INTEGER PRIMARY KEY, store_id INTEGER)")
        ctx = MigrationContext.configure(conn)
        module.op = Operations(ctx)
        module.upgrade()
        module.upgrade()  # idempotent
        insp = sa_.inspect(conn)
        cols = {c["name"] for c in insp.get_columns("bank_daily_match")}
        assert cols == {c.name for c in BankDailyMatch.__table__.columns}
        txn_cols = {c["name"]: c for c in insp.get_columns("bank_transaction")}
        for name in ("dismissed_at", "dismissed_by"):
            assert name in BankTransaction.__table__.columns
            assert txn_cols[name]["nullable"] is True
        module.downgrade()
        assert "bank_daily_match" not in sa_.inspect(conn).get_table_names()


def test_migration_does_not_import_application_code():
    for line in _MIGRATION.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped


def test_matches_purge_with_the_store():
    from api.Modules.Billing.Services.retention import (
        STORE_OWNED_MODELS, _store_owned_models,
    )
    assert STORE_OWNED_MODELS.index("BankDailyMatch") < STORE_OWNED_MODELS.index("BankTransaction")
    names = [m.__name__ for m, _ in _store_owned_models()]
    assert "BankDailyMatch" in names
