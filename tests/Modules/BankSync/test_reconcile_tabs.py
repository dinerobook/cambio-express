"""The Bank page's To reconcile / Reconciled tabs (owner, 2026-11-11).

The bug: a row a rule or a person had already given a category, or
that was matched to the daily book, stayed in the one list beside the
rows still needing work. ``GET /bank/transactions?tab=`` now splits the
list with ONE rule, ``reconcile.to_reconcile_clauses`` — the same one
the bell's bank item counts — so the page and the bell never disagree:

  * switch off: no category yet = to reconcile; a tag (rule or by
    hand) = reconciled; a void row is never to do;
  * switch on: the matching ``review`` status — matched / added from
    bank / a P&L or other tag / dismissed = reconciled; untagged, or a
    daily-book tag with nothing booked or matched = to reconcile;
  * the two tabs split the rows with none in both and none in neither;
    "" lists every row; undoing (untag, unmatch, restore) moves a row
    back;
  * each tab's count follows the other filters and ignores the tab;
  * grant / deny / bad value; another store's rows never count.
"""
from datetime import date, timedelta

from tests._app import db, db_session
from tests.Modules.BankSync.test_matching import (
    BANK, MON, _account, _categorize, _employee, _line, _switch_on, _txn,
    admin,  # noqa: F401 — the fixture
)


def _list(client, headers, query=""):
    resp = client.get(f"{BANK}/transactions{query}", headers=headers)
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()


def _ids(body):
    return {r["id"] for r in body["rows"]}


def _tabs(client, headers, extra=""):
    todo = _list(client, headers, f"?tab=to_reconcile{extra}")
    done = _list(client, headers, f"?tab=reconciled{extra}")
    every = _list(client, headers, f"?per_page=500{extra.replace('?', '&')}")
    return todo, done, every


def _void(tid):
    from api.Modules.BankSync.Models import BankTransaction
    with db_session():
        db.session.get(BankTransaction, tid).status = "void"
        db.session.commit()


def _bell_count(store_id):
    from api.Modules.Notifications.Services.bell.sources.bank import collect_to_check
    from api.Modules.Notifications.Services.bell.types import BellContext
    with db_session():
        ctx = BellContext(db=db.session, store_id=store_id, user_id=0,
                          today=date(2026, 5, 4), business_type="msb")
        items = collect_to_check(ctx)
        return items[0].count if items else 0


# ── switch off: a category is what reconciles a row ─────────


def test_switch_off_tagged_rows_leave_the_to_reconcile_tab(client, test_store_id, admin):
    a = _account(test_store_id)
    untagged = _txn(test_store_id, a, -1_500, MON, desc="UNKNOWN")
    by_rule = _txn(test_store_id, a, -250, MON, desc="FEE",
                   slug="bank_charge_230")
    by_hand = _txn(test_store_id, a, 20_000, MON, desc="DEPOSIT")
    _categorize(by_hand, "pl_credit_card_fees")
    void = _txn(test_store_id, a, -999, MON, desc="VOIDED")
    _void(void)

    todo, done, every = _tabs(client, admin)
    assert _ids(todo) == {untagged}
    assert _ids(done) == {by_rule, by_hand, void}
    assert _ids(every) == {untagged, by_rule, by_hand, void}
    for body in (todo, done, every):
        assert body["to_reconcile_count"] == 1
        assert body["reconciled_count"] == 3
    assert todo["total"] == 1 and done["total"] == 3
    assert _bell_count(test_store_id) == todo["to_reconcile_count"]


def test_switch_off_clearing_a_category_brings_the_row_back(client, test_store_id, admin):
    a = _account(test_store_id)
    tid = _txn(test_store_id, a, 20_000, MON)
    resp = client.post(f"{BANK}/transactions/{tid}/categorize",
                       json={"target_kind": "pl_credit_card_fees"}, headers=admin)
    assert resp.status_code == 200
    assert _ids(_list(client, admin, "?tab=reconciled")) == {tid}
    assert _ids(_list(client, admin, "?tab=to_reconcile")) == set()
    assert client.post(f"{BANK}/transactions/{tid}/uncategorize",
                       headers=admin).status_code == 200
    assert _ids(_list(client, admin, "?tab=to_reconcile")) == {tid}
    assert _ids(_list(client, admin, "?tab=reconciled")) == set()


# ── switch on: matched / added / dismissed reconcile a row ──


def test_switch_on_uses_the_matching_review_rule(client, test_store_id, admin):
    a = _account(test_store_id)
    _line(test_store_id, "check_deposit", 300.00, MON)
    matched = _txn(test_store_id, a, 30_000, MON + timedelta(days=1))
    _switch_on(test_store_id)
    _categorize(matched, "check_deposit")              # links to the typed entry
    added = _txn(test_store_id, a, 44_400, MON, desc="DROP")
    _categorize(added, "drop")                          # no entry: the feed books it
    pl = _txn(test_store_id, a, -3_000, MON, slug="pl_credit_card_fees")
    not_booked = _txn(test_store_id, a, 55_500, MON, desc="NOT BOOKED")
    _categorize(not_booked, "check_deposit", post_to_daily=False)
    untagged = _txn(test_store_id, a, 66_600, MON, desc="NEW")
    gone = _txn(test_store_id, a, 77_700, MON, desc="OLD")
    assert client.post(f"{BANK}/transactions/dismiss", json={"ids": [gone]},
                       headers=admin).get_json() == {"dismissed": 1, "skipped": 0}

    todo, done, every = _tabs(client, admin)
    assert _ids(todo) == {not_booked, untagged}
    assert _ids(done) == {matched, added, pl, gone}
    assert _ids(todo) | _ids(done) == _ids(every)
    assert not _ids(todo) & _ids(done)
    assert todo["to_reconcile_count"] == 2 and todo["reconciled_count"] == 4
    # The tab and the page's own "to review" count are the same rule.
    assert todo["books_counts"]["to_review"] == 2
    assert _bell_count(test_store_id) == 2


def test_switch_on_unmatch_and_restore_bring_rows_back(client, test_store_id, admin):
    a = _account(test_store_id)
    _line(test_store_id, "check_deposit", 300.00, MON)
    matched = _txn(test_store_id, a, 30_000, MON)
    _switch_on(test_store_id)
    _categorize(matched, "check_deposit")
    gone = _txn(test_store_id, a, 12_300, MON, desc="OLD")
    client.post(f"{BANK}/transactions/dismiss", json={"ids": [gone]}, headers=admin)
    assert _ids(_list(client, admin, "?tab=reconciled")) == {matched, gone}

    assert client.post(f"{BANK}/transactions/{matched}/unmatch",
                       headers=admin).status_code == 200
    assert client.post(f"{BANK}/transactions/{gone}/restore",
                       headers=admin).status_code == 200
    assert _ids(_list(client, admin, "?tab=to_reconcile")) == {matched, gone}
    assert _ids(_list(client, admin, "?tab=reconciled")) == set()


# ── counts, filters, scope, access ──────────────────────────


def test_tab_counts_follow_the_other_filters_not_the_tab(client, test_store_id, admin):
    a = _account(test_store_id)
    _txn(test_store_id, a, -100, MON, desc="WIRE FEE")
    _txn(test_store_id, a, -200, MON, desc="WIRE FEE", slug="bank_charge_230")
    _txn(test_store_id, a, -300, MON, desc="ATM", slug="bank_charge_230")
    _txn(test_store_id, a, 400, MON, desc="ATM")
    body = _list(client, admin, "?tab=reconciled&q=wire")
    assert [r["description"] for r in body["rows"]] == ["WIRE FEE"]
    assert body["to_reconcile_count"] == 1 and body["reconciled_count"] == 1
    body = _list(client, admin, "?tab=to_reconcile&sign=credit")
    assert [r["amount_cents"] for r in body["rows"]] == [400]
    assert body["to_reconcile_count"] == 1 and body["reconciled_count"] == 0


def test_another_stores_rows_never_count(client, test_store_id, admin):
    from tests.Modules.Notifications.test_bell import _second_store
    other = _second_store()
    b = _account(other, last4="9999")
    _txn(other, b, -100, MON)
    _txn(other, b, -200, MON, slug="bank_charge_9999")
    body = _list(client, admin, "?tab=to_reconcile")
    assert body["rows"] == []
    assert body["to_reconcile_count"] == 0 and body["reconciled_count"] == 0


def test_unknown_tab_is_refused(client, test_store_id, admin):
    resp = client.get(f"{BANK}/transactions?tab=done", headers=admin)
    assert resp.status_code == 422


def test_tabs_need_bank_read(client, test_store_id):
    a = _account(test_store_id)
    _txn(test_store_id, a, -100, MON)
    nobody, _ = _employee(client, test_store_id, "tab_none", {"time_clock": {"read": True}})
    reader, _ = _employee(client, test_store_id, "tab_read", {"bank_sync": {"read": True}})
    for tab in ("to_reconcile", "reconciled"):
        assert client.get(f"{BANK}/transactions?tab={tab}",
                          headers=nobody).status_code == 403
        assert client.get(f"{BANK}/transactions?tab={tab}",
                          headers=reader).status_code == 200
