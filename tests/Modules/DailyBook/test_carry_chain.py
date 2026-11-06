"""The forward-balance carry across days (INVARIANTS.md
"Forward-balance carry"), found in the 2026-11-06 daily book review.

A day's opening cash is carried from the last earlier day whose cash
was COUNTED (safe balance, cash deposit or drops). Pinned here:

  * fixing an earlier day re-stores the next day's opening cash and
    over/short, so the calendar, the Monthly P&L's over/short line and
    the daily email agree with the day's own page;
  * a LOCKED later day is frozen — it was reconciled, so it keeps its
    numbers (owner, 2026-11-06); the carry is still reported beside;
  * a day nobody closed (a Sunday return-check payment, a lone entry,
    an empty locked day) does not zero the next day's opening cash;
  * saving a counted day before the store's first day keeps the first
    day's typed opening balance (it is pinned);
  * a day made by an entry alone stores the carried opening balance.
"""
from datetime import date

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin

SAT = date(2026, 3, 7)
SUN = date(2026, 3, 8)
MON = date(2026, 3, 9)
TUE = date(2026, 3, 10)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def admin(client, test_store_id):
    return _h(login_admin(client, test_store_id))


def _put(client, sid, h, d, **fields):
    resp = client.put(f"/api/v2/daily/{sid}/{d.isoformat()}", json=fields, headers=h)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()["report"]


def _day(client, sid, h, d):
    resp = client.get(f"/api/v2/daily/{sid}/{d.isoformat()}", headers=h)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()["report"]


def _calendar(client, sid, h, d):
    resp = client.get(
        f"/api/v2/daily/{sid}/period?from=2026-03-01&to=2026-03-31", headers=h,
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return {r["report_date"]: r for r in resp.get_json()["rows"]}[d.isoformat()]


def _stored(sid, d):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        r = db.session.query(DailyReport).filter_by(
            store_id=sid, report_date=d,
        ).one()
        return float(r.forward_balance or 0), float(r.over_short or 0)


def _lock(client, sid, h, d):
    resp = client.post(f"/api/v2/daily/{sid}/{d.isoformat()}/lock", headers=h)
    assert resp.status_code == 200, resp.get_data(as_text=True)


def _entry(client, sid, h, d, kind="cash_purchase", amount=100.0):
    resp = client.post(
        f"/api/v2/daily/{sid}/{d.isoformat()}/line-items",
        json={"kind": kind, "amount": amount, "at_time": ""}, headers=h,
    )
    assert resp.status_code == 201, resp.get_data(as_text=True)
    return resp.get_json()


def _payback_on(client, h, d, amount=50.0):
    rc = client.post("/api/v2/return-checks", json={
        "bounced_on": "2026-03-01", "customer_name": "Ana",
        "company_name": "X", "check_number": "1", "payer_bank": "B",
        "amount": 200.0,
    }, headers=h).get_json()["return_check"]
    resp = client.post(
        f"/api/v2/return-checks/{rc['id']}/payments",
        json={"paid_on": d.isoformat(), "amount": amount}, headers=h,
    )
    assert resp.status_code == 201, resp.get_data(as_text=True)


@pytest.fixture
def two_days(client, test_store_id, admin):
    """Saturday opens with 1,000 and keeps 1,000 in the safe; Monday
    takes 200 in sales and keeps 1,200."""
    _put(client, test_store_id, admin, SAT, forward_balance=1000.0,
         safe_balance=1000.0)
    _put(client, test_store_id, admin, MON, taxable_sales=200.0,
         safe_balance=1200.0)
    return test_store_id


# ── Fixing an earlier day ──────────────────────────────────


def test_fixing_an_earlier_day_restores_the_next_days_numbers(
    client, two_days, admin,
):
    sid = two_days
    assert _stored(sid, MON) == (1000.0, 0.0)
    _put(client, sid, admin, SAT, forward_balance=1000.0, safe_balance=700.0)
    day = _day(client, sid, admin, MON)
    assert (day["forward_balance"], day["over_short"]) == (700.0, 300.0)
    # The stored columns, and so every reader of them, agree.
    assert _stored(sid, MON) == (700.0, 300.0)
    cal = _calendar(client, sid, admin, MON)
    assert (cal["forward_balance"], cal["over_short"]) == (700.0, 300.0)


def test_the_monthly_over_short_line_follows_the_fix(client, two_days, admin):
    from api.Modules.Monthly.Services.daily_feed import daily_feed_for_month
    sid = two_days
    # Saturday balances (300 went to the bank); Monday is now 300 over.
    _put(client, sid, admin, SAT, forward_balance=1000.0, safe_balance=700.0,
         cash_deposit=300.0)
    with db_session():
        feed = daily_feed_for_month(db.session, sid, 2026, 3)
    assert feed.fed["over_short"] == 300.0


def test_a_drop_on_the_earlier_day_moves_the_next_days_carry(
    client, two_days, admin,
):
    sid = two_days
    _entry(client, sid, admin, SAT, kind="drop", amount=250.0)
    assert _stored(sid, MON)[0] == 1250.0
    assert _calendar(client, sid, admin, MON)["forward_balance"] == 1250.0


def test_the_refresh_stops_at_the_next_counted_day(client, two_days, admin):
    sid = two_days
    _put(client, sid, admin, TUE, safe_balance=1200.0)
    _put(client, sid, admin, SAT, forward_balance=1000.0, safe_balance=700.0)
    # Tuesday carries Monday's safe, which did not change.
    assert _stored(sid, TUE)[0] == 1200.0
    assert _day(client, sid, admin, TUE)["forward_balance"] == 1200.0


# ── A locked later day is frozen ───────────────────────────


def test_a_locked_later_day_keeps_its_numbers(client, two_days, admin):
    sid = two_days
    _lock(client, sid, admin, MON)
    _put(client, sid, admin, SAT, forward_balance=1000.0, safe_balance=700.0)
    day = _day(client, sid, admin, MON)
    assert (day["forward_balance"], day["over_short"]) == (1000.0, 0.0)
    # What the chain would carry now is still reported beside it.
    assert day["forward_balance_carry"] == 700.0
    assert _stored(sid, MON) == (1000.0, 0.0)
    cal = _calendar(client, sid, admin, MON)
    assert (cal["forward_balance"], cal["over_short"]) == (1000.0, 0.0)


def test_unlocking_and_saving_takes_the_corrected_carry(client, two_days, admin):
    sid = two_days
    _lock(client, sid, admin, MON)
    _put(client, sid, admin, SAT, forward_balance=1000.0, safe_balance=700.0)
    resp = client.post(f"/api/v2/daily/{sid}/{MON.isoformat()}/unlock", headers=admin)
    assert resp.status_code == 200
    assert _day(client, sid, admin, MON)["forward_balance"] == 700.0
    _put(client, sid, admin, MON, taxable_sales=200.0, safe_balance=1200.0)
    assert _stored(sid, MON) == (700.0, 300.0)


def test_locking_stores_the_numbers_it_freezes(client, test_store_id, admin):
    sid = test_store_id
    _put(client, sid, admin, SAT, forward_balance=1000.0, safe_balance=1000.0)
    # Monday made by an entry only, then locked straight from the API.
    _entry(client, sid, admin, MON, amount=100.0)
    _lock(client, sid, admin, MON)
    assert _stored(sid, MON) == (1000.0, -900.0)


# ── A day nobody closed ────────────────────────────────────


def test_a_sunday_payback_does_not_zero_mondays_opening_cash(
    client, two_days, admin,
):
    sid = two_days
    _payback_on(client, admin, SUN)
    day = _day(client, sid, admin, MON)
    assert day["forward_balance"] == 1000.0
    assert _stored(sid, MON) == (1000.0, 0.0)
    # Sunday itself opens with Saturday's close.
    assert _day(client, sid, admin, SUN)["forward_balance"] == 1000.0


def test_a_lone_entry_on_a_closed_day_does_not_zero_the_carry(
    client, two_days, admin,
):
    sid = two_days
    _entry(client, sid, admin, SUN, amount=40.0)
    assert _day(client, sid, admin, MON)["forward_balance"] == 1000.0


def test_an_empty_locked_day_passes_the_carry_through(client, two_days, admin):
    sid = two_days
    _lock(client, sid, admin, SUN)
    assert _day(client, sid, admin, MON)["forward_balance"] == 1000.0
    assert _calendar(client, sid, admin, MON)["forward_balance"] == 1000.0


def test_a_counted_day_still_carries_a_real_zero(client, test_store_id, admin):
    """Everything went to the bank: the safe really is empty."""
    sid = test_store_id
    _put(client, sid, admin, SAT, forward_balance=1000.0, safe_balance=1000.0)
    _put(client, sid, admin, SUN, cash_deposit=1000.0, safe_balance=0.0)
    assert _day(client, sid, admin, MON)["forward_balance"] == 0.0


def test_an_unsaved_day_after_only_uncounted_days_is_a_first_day(
    client, test_store_id, admin,
):
    """Nothing was ever counted: the next day is the store's first and
    its opening cash is typed by hand (the book reads 404 until then)."""
    sid = test_store_id
    _entry(client, sid, admin, SAT, amount=40.0)
    resp = client.get(f"/api/v2/daily/{sid}/{MON.isoformat()}", headers=admin)
    assert resp.status_code == 404
    day = _put(client, sid, admin, MON, forward_balance=500.0)
    assert day["forward_balance"] == 500.0
    assert day["forward_balance_auto"] is False


# ── The store's first day ──────────────────────────────────


def test_back_filling_before_the_first_day_keeps_its_opening_cash(
    client, test_store_id, admin,
):
    sid = test_store_id
    _put(client, sid, admin, MON, forward_balance=1500.0, safe_balance=1500.0)
    _put(client, sid, admin, SAT, forward_balance=300.0, safe_balance=0.0,
         cash_deposit=300.0)
    day = _day(client, sid, admin, MON)
    assert day["forward_balance"] == 1500.0
    assert day["forward_balance_overridden"] is True
    # The carry the new chain would give is shown beside it.
    assert day["forward_balance_carry"] == 0.0
    assert _stored(sid, MON)[0] == 1500.0


def test_an_uncounted_earlier_day_does_not_pin_the_first_day(
    client, test_store_id, admin,
):
    sid = test_store_id
    _put(client, sid, admin, MON, forward_balance=1500.0, safe_balance=1500.0)
    _put(client, sid, admin, SAT, notes="closed")
    day = _day(client, sid, admin, MON)
    assert day["forward_balance"] == 1500.0
    assert day["forward_balance_overridden"] is False
    assert day["forward_balance_auto"] is False


# ── A day made by entries alone ────────────────────────────


def test_a_day_made_by_an_entry_stores_the_carried_opening_cash(
    client, two_days, admin,
):
    sid = two_days
    _entry(client, sid, admin, TUE, kind="drop", amount=100.0)
    assert _stored(sid, TUE) == (1200.0, -1100.0)
    cal = _calendar(client, sid, admin, TUE)
    day = _day(client, sid, admin, TUE)
    assert cal["forward_balance"] == day["forward_balance"] == 1200.0
    assert cal["over_short"] == day["over_short"] == -1100.0


def test_a_services_save_stores_the_carried_opening_cash(
    client, two_days, admin,
):
    sid = two_days
    resp = client.put(
        f"/api/v2/daily/{sid}/{TUE.isoformat()}/mt-breakdown",
        json={"rows": [{"company": "Intermex", "amount": 100.0, "fees": 0,
                        "federal_tax": 0, "commission": 0}]},
        headers=admin,
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert _stored(sid, TUE) == (1200.0, -1300.0)
