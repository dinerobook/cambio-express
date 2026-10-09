"""Held checks — a client's checks cashed today, deposited later.

A ``check_hold`` entry is the cash paid out for checks the store keeps
(an Out line, like a same-day check deposit). It is always open and
shows on the "Checks on hand" list until ``held_check_deposit``
entries linked to it add up to its amount. A held-check deposit moves
NO cash: its column is in no daily total. Invariants under test (see
DailyBook/INVARIANTS.md "Held checks"):

  * the hold counts in that day's Out total and over/short, exactly
    like a check deposit, and is open whatever the client sends;
  * the deposit, full or partial, leaves the deposit day's totals and
    over/short untouched and closes the hold;
  * a deposit can't exist unlinked, go against a cash entry, exceed
    what is held, predate the hold, or land on a locked day;
  * a hold with deposits can't be deleted or shrunk below them;
    removing a deposit puts the checks back on hand;
  * days written before the feature (NULL columns) total as before;
  * the bank feed never books either kind and offers a
    "Held checks deposited" tag that books nothing;
  * read / create permissions gate the flow.
"""
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee


FRI = date.today() - timedelta(days=7)
THU = FRI + timedelta(days=6)
WED = FRI + timedelta(days=5)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def admin(client, test_store_id):
    return _h(login_admin(client, test_store_id))


def _add(client, sid, headers, d, **body):
    body.setdefault("at_time", "")
    return client.post(
        f"/api/v2/daily/{sid}/{d.isoformat()}/line-items",
        json=body, headers=headers,
    )


def _hold(client, sid, headers, amount=4000.0, d=FRI, **extra):
    resp = _add(client, sid, headers, d, kind="check_hold", amount=amount,
                note="ABC Construction, 12 checks", **extra)
    assert resp.status_code == 201, resp.get_data(as_text=True)
    return resp.get_json()


def _deposit(client, sid, headers, hold_id, amount, d=THU):
    return _add(client, sid, headers, d, kind="held_check_deposit",
                amount=amount, settles_item_id=hold_id)


def _open(client, sid, headers):
    resp = client.get(f"/api/v2/daily/{sid}/settlements/open", headers=headers)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()["items"]


def _day(client, sid, headers, d):
    resp = client.get(f"/api/v2/daily/{sid}/{d.isoformat()}", headers=headers)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()["report"]


def _lock(sid, d):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        r = db.session.query(DailyReport).filter_by(
            store_id=sid, report_date=d,
        ).first()
        if r is None:
            r = DailyReport(store_id=sid, report_date=d)
            db.session.add(r)
        r.locked_at = datetime.utcnow()
        db.session.commit()


# ── The hold ───────────────────────────────────────────────


def test_hold_counts_as_cash_out_like_a_check_deposit(
    client, test_store_id, admin,
):
    # Two identical days: one deposits the checks the same day, the
    # other holds them. Out total and over/short must match.
    same_day = FRI - timedelta(days=1)
    assert _add(client, test_store_id, admin, same_day, kind="check_deposit",
                amount=4000.0).status_code == 201
    _hold(client, test_store_id, admin)
    deposited = _day(client, test_store_id, admin, same_day)
    held = _day(client, test_store_id, admin, FRI)
    assert held["checks_held"] == 4000.0
    assert held["checks_deposit"] == 0.0
    assert held["total_disbursements"] == deposited["total_disbursements"] == 4000.0
    assert held["over_short"] == pytest.approx(
        deposited["over_short"] - deposited["forward_balance"]
        + held["forward_balance"],
    )
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        r = db.session.query(DailyReport).filter_by(
            store_id=test_store_id, report_date=FRI,
        ).one()
        assert r.over_short == r.computed_over_short


def test_hold_is_open_even_when_the_client_says_otherwise(
    client, test_store_id, admin,
):
    row = _hold(client, test_store_id, admin, expects_settlement=False)
    assert row["expects_settlement"] is True
    assert row["settle_by"] is None  # deposit-by is optional
    items = _open(client, test_store_id, admin)
    assert [(i["id"], i["kind"], i["outstanding"]) for i in items] == [
        (row["id"], "check_hold", 4000.0),
    ]


def test_hold_with_a_deposit_by_date(client, test_store_id, admin):
    row = _hold(client, test_store_id, admin, settle_by=THU.isoformat())
    assert row["settle_by"] == THU.isoformat()
    assert _open(client, test_store_id, admin)[0]["settle_by"] == THU.isoformat()


def test_deposit_by_before_the_hold_is_refused(client, test_store_id, admin):
    resp = _add(client, test_store_id, admin, FRI, kind="check_hold",
                amount=10.0, settle_by=(FRI - timedelta(days=1)).isoformat())
    assert resp.status_code == 422


# ── The deposit ────────────────────────────────────────────


def test_partial_then_full_deposit_moves_no_cash(client, test_store_id, admin):
    hold = _hold(client, test_store_id, admin)
    before = _day(client, test_store_id, admin, WED)

    first = _deposit(client, test_store_id, admin, hold["id"], 2500.0, d=WED)
    assert first.status_code == 201, first.get_data(as_text=True)
    assert first.get_json()["settles_item_id"] == hold["id"]
    after = _day(client, test_store_id, admin, WED)
    assert after["held_checks_deposited"] == 2500.0
    # The cash left on Friday — the deposit day's numbers don't move.
    for key in ("total_receipts", "total_disbursements", "net",
                "over_short", "checks_deposit"):
        assert after[key] == before[key], key
    items = _open(client, test_store_id, admin)
    assert items[0]["settled"] == 2500.0
    assert items[0]["outstanding"] == 1500.0
    assert items[0]["returns"][0]["report_date"] == WED.isoformat()

    second = _deposit(client, test_store_id, admin, hold["id"], 1500.0)
    assert second.status_code == 201
    assert _open(client, test_store_id, admin) == []
    thu = _day(client, test_store_id, admin, THU)
    assert thu["held_checks_deposited"] == 1500.0
    assert thu["total_disbursements"] == 0.0
    # Friday is untouched by either deposit.
    assert _day(client, test_store_id, admin, FRI)["total_disbursements"] == 4000.0


def test_deposit_without_a_hold_is_refused(client, test_store_id, admin):
    resp = _add(client, test_store_id, admin, THU,
                kind="held_check_deposit", amount=100.0)
    assert resp.status_code == 422
    assert "Checks on hand" in resp.get_json()["detail"]


def test_deposit_over_what_is_held_is_refused(client, test_store_id, admin):
    hold = _hold(client, test_store_id, admin, amount=100.0)
    assert _deposit(client, test_store_id, admin, hold["id"], 100.01).status_code == 422
    assert _day(client, test_store_id, admin, THU)["held_checks_deposited"] == 0.0


def test_deposit_before_the_hold_is_refused(client, test_store_id, admin):
    hold = _hold(client, test_store_id, admin, d=THU)
    assert _deposit(client, test_store_id, admin, hold["id"], 10.0, d=FRI).status_code == 422


def test_deposit_and_cash_entries_do_not_mix(client, test_store_id, admin):
    hold = _hold(client, test_store_id, admin)
    # A cash in can't "return" a hold…
    cash = _add(client, test_store_id, admin, THU, kind="other_cash_in",
                amount=10.0, settles_item_id=hold["id"])
    assert cash.status_code == 422
    assert "held-check deposit" in cash.get_json()["detail"]
    # …and a held-check deposit can't settle lent cash.
    lent = _add(client, test_store_id, admin, FRI, kind="other_cash_out",
                amount=50.0, expects_settlement=True).get_json()
    wrong = _deposit(client, test_store_id, admin, lent["id"], 10.0)
    assert wrong.status_code == 422


def test_deposit_cannot_be_marked_open(client, test_store_id, admin):
    hold = _hold(client, test_store_id, admin)
    dep = _deposit(client, test_store_id, admin, hold["id"], 10.0).get_json()
    resp = client.patch(
        f"/api/v2/daily/{test_store_id}/line-items/{dep['id']}",
        json={"expects_settlement": True}, headers=admin,
    )
    assert resp.status_code == 409
    marked = _add(client, test_store_id, admin, THU, kind="held_check_deposit",
                  amount=5.0, expects_settlement=True)
    assert marked.status_code == 422


def test_editing_a_deposit_past_what_is_held_is_refused(
    client, test_store_id, admin,
):
    hold = _hold(client, test_store_id, admin, amount=1000.0)
    dep = _deposit(client, test_store_id, admin, hold["id"], 400.0).get_json()
    url = f"/api/v2/daily/{test_store_id}/line-items/{dep['id']}"
    assert client.patch(url, json={"amount": 1000.0}, headers=admin).status_code == 200
    assert client.patch(url, json={"amount": 1000.5}, headers=admin).status_code == 409
    assert _day(client, test_store_id, admin, THU)["held_checks_deposited"] == 1000.0


def test_hold_with_deposits_cannot_be_deleted_or_shrunk(
    client, test_store_id, admin,
):
    hold = _hold(client, test_store_id, admin, amount=1000.0)
    dep = _deposit(client, test_store_id, admin, hold["id"], 600.0).get_json()
    url = f"/api/v2/daily/{test_store_id}/line-items"
    assert client.patch(f"{url}/{hold['id']}", json={"amount": 500.0},
                        headers=admin).status_code == 409
    assert client.delete(f"{url}/{hold['id']}", headers=admin).status_code == 409
    # Removing the deposit puts the checks back on hand…
    assert client.delete(f"{url}/{dep['id']}", headers=admin).status_code == 204
    assert _open(client, test_store_id, admin)[0]["outstanding"] == 1000.0
    assert _day(client, test_store_id, admin, THU)["held_checks_deposited"] == 0.0
    # …and then the hold itself can go, taking its Out line with it.
    assert client.delete(f"{url}/{hold['id']}", headers=admin).status_code == 204
    assert _open(client, test_store_id, admin) == []
    assert _day(client, test_store_id, admin, FRI)["checks_held"] == 0.0


def test_close_takes_a_hold_off_the_list_but_keeps_the_cash_out(
    client, test_store_id, admin,
):
    hold = _hold(client, test_store_id, admin)
    closed = client.patch(
        f"/api/v2/daily/{test_store_id}/line-items/{hold['id']}",
        json={"expects_settlement": False}, headers=admin,
    )
    assert closed.status_code == 200
    assert _open(client, test_store_id, admin) == []
    assert _day(client, test_store_id, admin, FRI)["checks_held"] == 4000.0
    assert _deposit(client, test_store_id, admin, hold["id"], 10.0).status_code == 422


def test_lent_cash_and_holds_share_the_open_list_by_kind(
    client, test_store_id, admin,
):
    """Owed to us / We owe filter the same list by kind; a hold must
    not leak into either (and vice versa)."""
    _add(client, test_store_id, admin, FRI, kind="other_cash_out",
         amount=50.0, expects_settlement=True)
    _hold(client, test_store_id, admin)
    kinds = sorted(i["kind"] for i in _open(client, test_store_id, admin))
    assert kinds == ["check_hold", "other_cash_out"]


# ── Lock ───────────────────────────────────────────────────


def test_deposit_onto_a_locked_day_is_refused(client, test_store_id, admin):
    hold = _hold(client, test_store_id, admin)
    _lock(test_store_id, THU)
    resp = _deposit(client, test_store_id, admin, hold["id"], 100.0)
    assert resp.status_code == 403
    assert _open(client, test_store_id, admin)[0]["outstanding"] == 4000.0


def test_deposit_works_when_only_the_hold_day_is_locked(
    client, test_store_id, admin,
):
    hold = _hold(client, test_store_id, admin)
    _lock(test_store_id, FRI)
    assert _deposit(client, test_store_id, admin, hold["id"], 4000.0).status_code == 201
    assert _open(client, test_store_id, admin) == []
    assert _day(client, test_store_id, admin, FRI)["checks_held"] == 4000.0


def test_new_hold_on_a_locked_day_is_refused(client, test_store_id, admin):
    _lock(test_store_id, FRI)
    resp = _add(client, test_store_id, admin, FRI, kind="check_hold", amount=1.0)
    assert resp.status_code == 403


def test_deposit_by_date_moves_on_a_locked_hold_day(client, test_store_id, admin):
    hold = _hold(client, test_store_id, admin)
    _lock(test_store_id, FRI)
    moved = client.patch(
        f"/api/v2/daily/{test_store_id}/line-items/{hold['id']}",
        json={"settle_by": THU.isoformat()}, headers=admin,
    )
    assert moved.status_code == 200
    assert moved.get_json()["settle_by"] == THU.isoformat()


# ── Existing days ──────────────────────────────────────────


def test_rows_from_before_the_feature_total_as_before():
    """Every report written before the migration has NULL in both
    columns; the totals must read them as zero."""
    from api.Modules.DailyBook.Models import DailyReport
    r = DailyReport(
        checks_deposit_cents=10_000, cash_purchases_cents=2_500,
        taxable_sales_cents=50_000,
        checks_held_cents=None, held_checks_deposited_cents=None,
    )
    assert r.total_disbursements_cents == 12_500
    assert r.checks_held == 0.0
    assert r.held_checks_deposited == 0.0
    assert r.computed_over_short_cents == 12_500 - 50_000


def test_held_deposit_is_in_no_total():
    from api.Modules.DailyBook.Models import DailyReport
    r = DailyReport(held_checks_deposited_cents=99_999)
    assert r.total_receipts_cents == 0
    assert r.total_disbursements_cents == 0
    assert r.computed_over_short_cents == 0


def test_daily_report_put_refuses_the_derived_columns(
    client, test_store_id, admin,
):
    for field in ("checks_held", "held_checks_deposited"):
        resp = client.put(
            f"/api/v2/daily/{test_store_id}/{FRI.isoformat()}",
            json={field: 1.0}, headers=admin,
        )
        assert resp.status_code == 422, field


# ── Migration ──────────────────────────────────────────────

_MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "alembic" / "versions" / "d8f3b6a2c4e1_daily_report_held_checks.py"
)


def test_migration_adds_exactly_the_model_columns():
    import importlib.util
    from api.Modules.DailyBook.Models import DailyReport
    spec = importlib.util.spec_from_file_location("held_mig", _MIGRATION)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod._COLUMNS == ("checks_held_cents", "held_checks_deposited_cents")
    for name in mod._COLUMNS:
        assert DailyReport.__table__.c[name].nullable is True


def test_migration_does_not_import_application_code():
    for line in _MIGRATION.read_text().splitlines():
        assert not line.strip().startswith(("import api", "from api")), line


# ── Bank feed ──────────────────────────────────────────────


def _bank_login(client, store_id):
    resp = client.post(
        "/api/v2/auth/login",
        json={"username": "admin@test.com", "password": "testpass123!",
              "store_id": store_id},
    )
    return {"Authorization": f"Bearer {resp.get_json()['access_token']}"}


def _seed_bank_txn(store_id):
    from api.Modules.BankSync.Models import BankTransaction, StripeBankAccount
    with db_session():
        a = StripeBankAccount(
            store_id=store_id, stripe_account_id="fcacc_held",
            institution_name="Bank", last4="0230", enabled=True,
        )
        db.session.add(a); db.session.commit()
        t = BankTransaction(
            store_id=store_id, stripe_bank_account_id=a.id,
            stripe_transaction_id="txn_held_1", amount_cents=400_000,
            description="DEPOSIT", category_slug="",
            posted_at=datetime(2026, 5, 6, 10, 0, 0), status="posted",
        )
        db.session.add(t); db.session.commit()
        return t.id


def test_bank_feed_never_offers_the_held_kinds(client, test_store_id):
    headers = _bank_login(client, test_store_id)
    groups = client.get("/api/v2/bank/categories", headers=headers).get_json()["groups"]
    daily = {o["slug"] for o in groups[0]["options"]}
    other = {o["slug"]: o["label"] for o in groups[2]["options"]}
    assert "check_hold" not in daily
    assert "held_check_deposit" not in daily
    assert "check_deposit" in daily
    assert other["held_checks_deposited"] == "Held checks deposited"


@pytest.mark.parametrize("slug", ["check_hold", "held_check_deposit"])
def test_bank_feed_refuses_to_book_the_held_kinds(client, test_store_id, slug):
    tid = _seed_bank_txn(test_store_id)
    resp = client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": slug}, headers=_bank_login(client, test_store_id),
    )
    assert resp.status_code == 422


def test_bank_tag_for_held_deposit_books_nothing(client, test_store_id):
    from api.Modules.DailyBook.Models import DailyLineItem
    tid = _seed_bank_txn(test_store_id)
    resp = client.post(
        f"/api/v2/bank/transactions/{tid}/categorize",
        json={"target_kind": "held_checks_deposited"},
        headers=_bank_login(client, test_store_id),
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.get_json()["transaction"]["category_slug"] == "held_checks_deposited"
    with db_session():
        assert db.session.query(DailyLineItem).filter_by(
            store_id=test_store_id,
        ).count() == 0


def test_book_to_daily_service_refuses_the_held_kinds(test_store_id):
    from api.Modules.BankSync.Models import BankTransaction
    from api.Modules.BankSync.Services.categorize import book_to_daily
    tid = _seed_bank_txn(test_store_id)
    with db_session():
        txn = db.session.get(BankTransaction, tid)
        for slug in ("check_hold", "held_check_deposit"):
            with pytest.raises(ValueError):
                book_to_daily(db.session, txn, slug)


# ── Access ─────────────────────────────────────────────────


def _employee(client, sid, username, matrix):
    from api.Core.Permissions import set_user_permissions
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=sid, username=username, role="employee",
                 is_active=True)
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()
        uid = u.id
    set_user_permissions(sid, uid, matrix)
    return _h(login_employee(client, sid, username, "emppass1234"))


def test_reader_sees_holds_but_cannot_hold_or_deposit(client, test_store_id, admin):
    hold = _hold(client, test_store_id, admin)
    reader = _employee(client, test_store_id, "held_ro",
                       {"daily_book": {"read": True}})
    assert len(_open(client, test_store_id, reader)) == 1
    assert _add(client, test_store_id, reader, FRI, kind="check_hold",
                amount=1.0).status_code == 403
    assert _deposit(client, test_store_id, reader, hold["id"], 1.0).status_code == 403
    writer = _employee(client, test_store_id, "held_rw",
                       {"daily_book": {"read": True, "create": True}})
    assert _deposit(client, test_store_id, writer, hold["id"], 1.0).status_code == 201


def test_no_book_access_sees_nothing(client, test_store_id, admin):
    _hold(client, test_store_id, admin)
    nobody = _employee(client, test_store_id, "held_none",
                       {"time_clock": {"read": True}})
    resp = client.get(
        f"/api/v2/daily/{test_store_id}/settlements/open", headers=nobody,
    )
    assert resp.status_code == 403


def test_hold_and_deposit_are_audited(client, test_store_id, admin):
    from api.Modules.Audit.Models import OperatorAuditLog
    hold = _hold(client, test_store_id, admin)
    dep = _deposit(client, test_store_id, admin, hold["id"], 10.0).get_json()
    with db_session():
        rows = {
            r.target_id: r.summary or ""
            for r in db.session.query(OperatorAuditLog).filter_by(
                action="create_line_item",
            )
        }
    assert "kind=check_hold" in rows[str(hold["id"])]
    assert "expects_settlement" in rows[str(hold["id"])]
    assert f"settles=#{hold['id']}" in rows[str(dep["id"])]
