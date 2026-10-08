"""Settlements — cash lent out / borrowed that comes back.

An Other cash out (lent) or Other cash in (borrowed) can be ticked
``expects_settlement``; entries of the opposite kind with
``settles_item_id`` pay it back. Invariants under test (see
DailyBook/INVARIANTS.md "Settlements"):

  * a plain entry behaves exactly as before and never shows as open,
  * the open list carries what is left, oldest first, across days,
  * a return can't exceed what's left, go the wrong way, predate the
    original, or settle another store's / an unmarked entry,
  * an original can't shrink below what came back or be deleted
    while returns point at it; unticking ("close") keeps the returns,
  * the lock refuses every line-item write, create and delete
    included,
  * read / create / update permissions gate the routes.
"""
from datetime import date, datetime, timedelta

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee


DAY1 = date.today() - timedelta(days=4)
DAY2 = DAY1 + timedelta(days=2)
DAY3 = DAY1 + timedelta(days=3)


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


def _lend(client, sid, headers, amount=2000.0, d=DAY1, **extra):
    resp = _add(
        client, sid, headers, d, kind="other_cash_out", amount=amount,
        note="Lent to Store #2", expects_settlement=True, **extra,
    )
    assert resp.status_code == 201, resp.get_data(as_text=True)
    return resp.get_json()


def _open(client, sid, headers):
    resp = client.get(f"/api/v2/daily/{sid}/settlements/open", headers=headers)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()["items"]


def _report_field(sid, d, field):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        r = db.session.query(DailyReport).filter_by(
            store_id=sid, report_date=d,
        ).first()
        return float(getattr(r, field) or 0) if r else 0.0


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


# ── Marking ────────────────────────────────────────────────


def test_plain_cash_out_is_unchanged_and_never_open(client, test_store_id, admin):
    resp = _add(client, test_store_id, admin, DAY1,
                kind="other_cash_out", amount=50.0, note="ice")
    assert resp.status_code == 201
    row = resp.get_json()
    assert row["expects_settlement"] is False
    assert row["settle_by"] is None
    assert row["settles_item_id"] is None
    assert _open(client, test_store_id, admin) == []
    assert _report_field(test_store_id, DAY1, "other_cash_out") == 50.0


def test_marked_cash_out_shows_as_open_on_any_day(client, test_store_id, admin):
    row = _lend(client, test_store_id, admin, settle_by=DAY2.isoformat())
    assert row["expects_settlement"] is True
    assert row["settle_by"] == DAY2.isoformat()
    items = _open(client, test_store_id, admin)
    assert len(items) == 1
    assert items[0]["id"] == row["id"]
    assert items[0]["kind"] == "other_cash_out"
    assert items[0]["outstanding"] == 2000.0
    assert items[0]["settled"] == 0.0
    assert items[0]["returns"] == []
    # The money left the drawer like any other cash out.
    assert _report_field(test_store_id, DAY1, "other_cash_out") == 2000.0


@pytest.mark.parametrize("kind", ["drop", "cash_expense", "from_bank"])
def test_only_other_cash_kinds_can_be_marked(client, test_store_id, admin, kind):
    resp = _add(client, test_store_id, admin, DAY1, kind=kind,
                amount=10.0, expects_settlement=True)
    assert resp.status_code == 422


def test_settle_by_before_the_day_is_refused(client, test_store_id, admin):
    resp = _add(client, test_store_id, admin, DAY2, kind="other_cash_out",
                amount=10.0, expects_settlement=True,
                settle_by=DAY1.isoformat())
    assert resp.status_code == 422


def test_settle_by_without_mark_is_refused(client, test_store_id, admin):
    resp = _add(client, test_store_id, admin, DAY1, kind="other_cash_out",
                amount=10.0, settle_by=DAY2.isoformat())
    assert resp.status_code == 422


def test_cannot_both_expect_and_settle(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin)
    resp = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
                amount=10.0, expects_settlement=True,
                settles_item_id=lent["id"])
    assert resp.status_code == 422


def test_mark_later_via_patch_and_clear_date(client, test_store_id, admin):
    resp = _add(client, test_store_id, admin, DAY1,
                kind="other_cash_out", amount=300.0)
    item_id = resp.get_json()["id"]
    patched = client.patch(
        f"/api/v2/daily/{test_store_id}/line-items/{item_id}",
        json={"expects_settlement": True, "settle_by": DAY3.isoformat()},
        headers=admin,
    )
    assert patched.status_code == 200
    assert patched.get_json()["expects_settlement"] is True
    assert patched.get_json()["settle_by"] == DAY3.isoformat()
    cleared = client.patch(
        f"/api/v2/daily/{test_store_id}/line-items/{item_id}",
        json={"settle_by": None}, headers=admin,
    )
    assert cleared.get_json()["settle_by"] is None
    assert cleared.get_json()["expects_settlement"] is True


def test_patch_marking_a_wrong_kind_is_refused(client, test_store_id, admin):
    resp = _add(client, test_store_id, admin, DAY1, kind="drop", amount=5.0)
    patched = client.patch(
        f"/api/v2/daily/{test_store_id}/line-items/{resp.get_json()['id']}",
        json={"expects_settlement": True}, headers=admin,
    )
    assert patched.status_code == 409


# ── Returns ────────────────────────────────────────────────


def test_partial_then_full_return(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin)
    r1 = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
              amount=500.0, note="Store #2", settles_item_id=lent["id"])
    assert r1.status_code == 201
    assert r1.get_json()["settles_item_id"] == lent["id"]
    # The return is an ordinary cash in on the day it came back.
    assert _report_field(test_store_id, DAY2, "other_cash_in") == 500.0

    items = _open(client, test_store_id, admin)
    assert items[0]["settled"] == 500.0
    assert items[0]["outstanding"] == 1500.0
    assert items[0]["returns"] == [{
        "id": r1.get_json()["id"],
        "report_date": DAY2.isoformat(), "amount": 500.0,
    }]
    # The day's list reports how much of the original came back.
    day1 = client.get(
        f"/api/v2/daily/{test_store_id}/{DAY1.isoformat()}/line-items",
        headers=admin,
    ).get_json()["items"]
    assert [i["settled"] for i in day1 if i["id"] == lent["id"]] == [500.0]

    r2 = _add(client, test_store_id, admin, DAY3, kind="other_cash_in",
              amount=1500.0, settles_item_id=lent["id"])
    assert r2.status_code == 201
    assert _open(client, test_store_id, admin) == []


def test_borrowed_cash_in_is_paid_back_with_cash_out(client, test_store_id, admin):
    borrowed = _add(client, test_store_id, admin, DAY1, kind="other_cash_in",
                    amount=800.0, note="From Ana", expects_settlement=True)
    assert borrowed.status_code == 201
    bid = borrowed.get_json()["id"]
    assert _open(client, test_store_id, admin)[0]["kind"] == "other_cash_in"
    wrong = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
                 amount=100.0, settles_item_id=bid)
    assert wrong.status_code == 422
    paid = _add(client, test_store_id, admin, DAY2, kind="other_cash_out",
                amount=800.0, settles_item_id=bid)
    assert paid.status_code == 201
    assert _report_field(test_store_id, DAY2, "other_cash_out") == 800.0
    assert _open(client, test_store_id, admin) == []


def test_return_over_outstanding_is_refused(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin, amount=100.0)
    resp = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
                amount=100.01, settles_item_id=lent["id"])
    assert resp.status_code == 422
    assert _report_field(test_store_id, DAY2, "other_cash_in") == 0.0


def test_return_in_the_same_direction_is_refused(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin)
    resp = _add(client, test_store_id, admin, DAY2, kind="other_cash_out",
                amount=10.0, settles_item_id=lent["id"])
    assert resp.status_code == 422


def test_return_dated_before_the_original_is_refused(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin, d=DAY2)
    resp = _add(client, test_store_id, admin, DAY1, kind="other_cash_in",
                amount=10.0, settles_item_id=lent["id"])
    assert resp.status_code == 422


def test_return_against_an_unmarked_entry_is_refused(client, test_store_id, admin):
    plain = _add(client, test_store_id, admin, DAY1,
                 kind="other_cash_out", amount=100.0).get_json()
    resp = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
                amount=10.0, settles_item_id=plain["id"])
    assert resp.status_code == 422


def test_return_against_another_stores_entry_is_refused(
    client, test_store_id, admin,
):
    from api.Modules.DailyBook.Models import DailyLineItem
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other", slug="other-settle", plan="trial")
        db.session.add(other)
        db.session.flush()
        foreign = DailyLineItem(
            store_id=other.id, report_date=DAY1, kind="other_cash_out",
            amount=500.0, expects_settlement=True,
        )
        db.session.add(foreign)
        db.session.commit()
        foreign_id = foreign.id
    resp = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
                amount=10.0, settles_item_id=foreign_id)
    assert resp.status_code == 422
    assert _open(client, test_store_id, admin) == []


def test_editing_a_return_past_outstanding_is_refused(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin, amount=1000.0)
    r = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
             amount=400.0, settles_item_id=lent["id"]).get_json()
    url = f"/api/v2/daily/{test_store_id}/line-items/{r['id']}"
    assert client.patch(url, json={"amount": 1000.0}, headers=admin).status_code == 200
    assert client.patch(url, json={"amount": 1000.5}, headers=admin).status_code == 409


def test_original_cannot_shrink_below_what_came_back(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin, amount=1000.0)
    _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
         amount=600.0, settles_item_id=lent["id"])
    url = f"/api/v2/daily/{test_store_id}/line-items/{lent['id']}"
    assert client.patch(url, json={"amount": 599.0}, headers=admin).status_code == 409
    ok = client.patch(url, json={"amount": 700.0}, headers=admin)
    assert ok.status_code == 200
    assert ok.get_json()["settled"] == 600.0
    assert _open(client, test_store_id, admin)[0]["outstanding"] == 100.0


def test_close_keeps_returns_and_leaves_the_open_list(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin, settle_by=DAY3.isoformat())
    r = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
             amount=500.0, settles_item_id=lent["id"]).get_json()
    closed = client.patch(
        f"/api/v2/daily/{test_store_id}/line-items/{lent['id']}",
        json={"expects_settlement": False}, headers=admin,
    )
    assert closed.status_code == 200
    assert closed.get_json()["expects_settlement"] is False
    assert closed.get_json()["settle_by"] is None
    assert _open(client, test_store_id, admin) == []
    # Nothing booked moves: the return stays where it was.
    assert _report_field(test_store_id, DAY2, "other_cash_in") == 500.0
    day2 = client.get(
        f"/api/v2/daily/{test_store_id}/{DAY2.isoformat()}/line-items",
        headers=admin,
    ).get_json()["items"]
    assert [i["settles_item_id"] for i in day2 if i["id"] == r["id"]] == [lent["id"]]
    day1 = client.get(
        f"/api/v2/daily/{test_store_id}/{DAY1.isoformat()}/line-items",
        headers=admin,
    ).get_json()["items"]
    # The closed original still reports what came back.
    assert [i["settled"] for i in day1 if i["id"] == lent["id"]] == [500.0]
    # A closed entry takes no new returns.
    again = _add(client, test_store_id, admin, DAY3, kind="other_cash_in",
                 amount=10.0, settles_item_id=lent["id"])
    assert again.status_code == 422


def test_a_return_cannot_itself_be_marked(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin)
    r = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
             amount=5.0, settles_item_id=lent["id"]).get_json()
    resp = client.patch(
        f"/api/v2/daily/{test_store_id}/line-items/{r['id']}",
        json={"expects_settlement": True}, headers=admin,
    )
    assert resp.status_code == 409


def test_original_with_returns_cannot_be_deleted(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin)
    r = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
             amount=500.0, settles_item_id=lent["id"]).get_json()
    url = f"/api/v2/daily/{test_store_id}/line-items"
    assert client.delete(f"{url}/{lent['id']}", headers=admin).status_code == 409
    # Removing the return puts the money back on the open list…
    assert client.delete(f"{url}/{r['id']}", headers=admin).status_code == 204
    assert _open(client, test_store_id, admin)[0]["outstanding"] == 2000.0
    assert _report_field(test_store_id, DAY2, "other_cash_in") == 0.0
    # …and then the original can go.
    assert client.delete(f"{url}/{lent['id']}", headers=admin).status_code == 204
    assert _open(client, test_store_id, admin) == []


def test_open_list_is_oldest_first(client, test_store_id, admin):
    later = _lend(client, test_store_id, admin, amount=10.0, d=DAY2)
    earlier = _lend(client, test_store_id, admin, amount=20.0, d=DAY1)
    assert [i["id"] for i in _open(client, test_store_id, admin)] == [
        earlier["id"], later["id"],
    ]


# ── Lock ───────────────────────────────────────────────────


def test_locked_day_refuses_create_and_delete(client, test_store_id, admin):
    """The lock blanket-refuses every line-item write. Create and
    delete used to slip past it (only PATCH checked)."""
    item = _add(client, test_store_id, admin, DAY1,
                kind="other_cash_out", amount=25.0).get_json()
    _lock(test_store_id, DAY1)
    create = _add(client, test_store_id, admin, DAY1,
                  kind="other_cash_out", amount=5.0)
    assert create.status_code == 403
    assert "lock" in create.get_data(as_text=True).lower()
    delete = client.delete(
        f"/api/v2/daily/{test_store_id}/line-items/{item['id']}",
        headers=admin,
    )
    assert delete.status_code == 403
    assert _report_field(test_store_id, DAY1, "other_cash_out") == 25.0


def test_return_onto_a_locked_day_is_refused(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin)
    _lock(test_store_id, DAY2)
    resp = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
                amount=100.0, settles_item_id=lent["id"])
    assert resp.status_code == 403
    assert _open(client, test_store_id, admin)[0]["outstanding"] == 2000.0


def test_closing_needs_the_original_day_unlocked(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin)
    _lock(test_store_id, DAY1)
    resp = client.patch(
        f"/api/v2/daily/{test_store_id}/line-items/{lent['id']}",
        json={"expects_settlement": False}, headers=admin,
    )
    assert resp.status_code == 403
    assert len(_open(client, test_store_id, admin)) == 1


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


def test_open_list_needs_daily_book_read(client, test_store_id, admin):
    _lend(client, test_store_id, admin)
    no_book = _employee(client, test_store_id, "settle_nobook",
                        {"time_clock": {"read": True}})
    resp = client.get(
        f"/api/v2/daily/{test_store_id}/settlements/open", headers=no_book,
    )
    assert resp.status_code == 403
    reader = _employee(client, test_store_id, "settle_reader",
                       {"daily_book": {"read": True}})
    assert len(_open(client, test_store_id, reader)) == 1


def test_recording_a_return_needs_create(client, test_store_id, admin):
    lent = _lend(client, test_store_id, admin)
    reader = _employee(client, test_store_id, "settle_ro",
                       {"daily_book": {"read": True}})
    resp = _add(client, test_store_id, reader, DAY2, kind="other_cash_in",
                amount=100.0, settles_item_id=lent["id"])
    assert resp.status_code == 403
    closing = client.patch(
        f"/api/v2/daily/{test_store_id}/line-items/{lent['id']}",
        json={"expects_settlement": False}, headers=reader,
    )
    assert closing.status_code == 403
    writer = _employee(client, test_store_id, "settle_rw",
                       {"daily_book": {"read": True, "create": True}})
    ok = _add(client, test_store_id, writer, DAY2, kind="other_cash_in",
              amount=100.0, settles_item_id=lent["id"])
    assert ok.status_code == 201


def test_open_list_refuses_other_store_and_superadmin(client, test_store_id):
    from tests.conftest import login_superadmin
    token = login_superadmin(client)
    resp = client.get(
        f"/api/v2/daily/{test_store_id}/settlements/open", headers=_h(token),
    )
    assert resp.status_code == 403


def test_open_list_needs_login(client, test_store_id):
    resp = client.get(f"/api/v2/daily/{test_store_id}/settlements/open")
    assert resp.status_code == 401


def test_return_is_audited(client, test_store_id, admin):
    from api.Modules.Audit.Models import OperatorAuditLog
    lent = _lend(client, test_store_id, admin)
    r = _add(client, test_store_id, admin, DAY2, kind="other_cash_in",
             amount=100.0, settles_item_id=lent["id"]).get_json()
    with db_session():
        row = db.session.query(OperatorAuditLog).filter_by(
            target_id=str(r["id"]), action="create_line_item",
        ).first()
        assert row is not None
        assert f"settles=#{lent['id']}" in (row.summary or "")
