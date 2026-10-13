"""Debit card and payouts in the daily book's Services box.

Per company, the Money transfer tab carries two more figures that come
OFF the company's total:

* Debit card — the part of the day's sends the customers paid on the
  company's card terminal. No cash reached the drawer (the company
  credits it on the statement), so it must not count as cash in.
* Payouts — cash the store paid out to recipients for that company. It
  left the drawer, so the day's cash goes down by the same amount.

`DailyReport.money_transfer` (and so over/short) is the cash figure.
See INVARIANTS.md "Debit card and payouts".
"""
from datetime import date, datetime, timedelta

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee

DAY = date.today() - timedelta(days=3)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def admin(client, test_store_id):
    return _h(login_admin(client, test_store_id))


def _url(sid, d=DAY):
    return f"/api/v2/daily/{sid}/{d.isoformat()}/mt-breakdown"


def _report(sid, d=DAY):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        return (db.session.query(DailyReport)
                  .filter_by(store_id=sid, report_date=d).first())


def _saved(sid, d=DAY):
    from api.Modules.DailyBook.Models import MoneyTransferSummary
    with db_session():
        return {
            r.company: (r.debit_card_cents, r.payouts_cents)
            for r in db.session.query(MoneyTransferSummary)
                       .filter_by(store_id=sid, report_date=d)
        }


INTERMEX = {"company": "Intermex", "amount": 1000.0, "fees": 50.0,
            "federal_tax": 10.0, "commission": 0.0}


# ── Service layer ──────────────────────────────────────────


def test_debit_card_and_payouts_come_off_the_cash(test_store_id):
    from api.Modules.DailyBook.Services import (
        MTWriteRow, read_mt_breakdown, replace_mt_breakdown,
    )
    with db_session():
        total = replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[MTWriteRow(company="Intermex", amount=1000, fees=50,
                             federal_tax=10, commission=0,
                             debit_card=212, payouts=300)],
        )
        db.session.commit()
        breakdown = read_mt_breakdown(db.session, test_store_id, DAY)
    # 1060 taken in, 212 of it by card, 300 paid out → 548 cash.
    assert total == pytest.approx(548.0)
    row = next(r for r in breakdown.rows if r.company == "Intermex")
    assert (row.saved_debit_card, row.saved_payouts) == (212.0, 300.0)
    assert row.saved_total == pytest.approx(548.0)
    rep = _report(test_store_id)
    assert rep.money_transfer == pytest.approx(548.0)
    # Over/short is refreshed with it: receipts carry the cash only.
    assert rep.over_short == pytest.approx(rep.computed_over_short)


def test_a_day_of_only_card_sends_is_still_saved(test_store_id):
    """Net cash is zero, but the row is not empty and must be kept —
    the old "skip when the total is 0" rule would have dropped it."""
    from api.Modules.DailyBook.Services import (
        MTWriteRow, replace_mt_breakdown,
    )
    with db_session():
        total = replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[MTWriteRow(company="Maxi", amount=100, fees=0,
                             federal_tax=0, commission=0, debit_card=100)],
        )
        db.session.commit()
    assert total == 0
    assert _saved(test_store_id) == {"Maxi": (10000, None)}


def test_unused_figures_stay_null(test_store_id):
    """A row saved without debit card or payouts reads exactly like a
    row saved before the columns existed."""
    from api.Modules.DailyBook.Services import (
        MTWriteRow, replace_mt_breakdown,
    )
    with db_session():
        replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[MTWriteRow(company="Maxi", amount=80, fees=4,
                             federal_tax=0.8, commission=0)],
        )
        db.session.commit()
    assert _saved(test_store_id) == {"Maxi": (None, None)}
    assert _report(test_store_id).money_transfer == pytest.approx(84.8)


@pytest.mark.parametrize("over, message", [
    ({"debit_card": -1}, "can't be negative"),
    ({"payouts": -5}, "can't be negative"),
    ({"debit_card": 1060.02}, "more than the amount"),
])
def test_impossible_rows_are_refused(test_store_id, over, message):
    from api.Modules.DailyBook.Services import (
        MTRowError, MTWriteRow, replace_mt_breakdown,
    )
    row = MTWriteRow(**{**INTERMEX, **over})
    with db_session():
        with pytest.raises(MTRowError, match=message):
            replace_mt_breakdown(db.session, store_id=test_store_id,
                                 report_date=DAY, rows=[row])
        db.session.rollback()
    assert _saved(test_store_id) == {}


def test_debit_card_equal_to_everything_taken_in_is_fine(test_store_id):
    from api.Modules.DailyBook.Services import (
        MTWriteRow, replace_mt_breakdown,
    )
    with db_session():
        replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[MTWriteRow(**{**INTERMEX, "debit_card": 1060.0})],
        )
        db.session.commit()
    assert _report(test_store_id).money_transfer == 0


def test_auto_figures_come_from_the_transfer_log(test_store_id):
    """The transfer log splits the same way: a debit card send counts
    in amount/fees/tax and in debit card (its total collected); a
    payout counts only in payouts; a cancelled payout counts nowhere."""
    from api.Modules.DailyBook.Services import (
        read_mt_breakdown, summarize_transfers_for_day,
    )
    from api.Modules.Transfers.Models import Transfer

    def t(**kw):
        base = dict(store_id=test_store_id, send_date=DAY, company="Barri",
                    service_type="Money Transfer", sender_name="X")
        return Transfer(**{**base, **kw})

    with db_session():
        db.session.add_all([
            t(send_amount=100, fee=5, federal_tax=1),
            t(send_amount=200, fee=8, federal_tax=2, commission=1,
              payment_method="debit_card"),
            t(send_amount=500, service_type="Payout", commission=2),
            t(send_amount=70, service_type="Payout", status="Cancelled"),
        ])
        db.session.commit()
        summary = summarize_transfers_for_day(db.session, test_store_id, DAY)
        breakdown = read_mt_breakdown(db.session, test_store_id, DAY)
    barri = next(b for b in summary.by_company if b.company == "Barri")
    assert (barri.count, barri.payout_count) == (2, 1)
    assert barri.amount == 300 and barri.fees == 13 and barri.federal_tax == 3
    assert barri.commission == 3
    assert barri.debit_card == 210
    assert barri.payouts == 500
    # 300 + 13 + 3 + 3 − 210 − 500
    assert barri.total == pytest.approx(-391.0)
    row = next(r for r in breakdown.rows if r.company == "Barri")
    assert (row.auto_debit_card, row.auto_payouts, row.auto_payout_count) == (
        210, 500, 1)
    assert row.auto_total == pytest.approx(-391.0)


# ── HTTP ───────────────────────────────────────────────────


def test_put_and_get_round_trip(client, test_store_id, admin):
    resp = client.put(_url(test_store_id), headers=admin, json={
        "rows": [{**INTERMEX, "debit_card": 60.0, "payouts": 400.0}],
    })
    assert resp.status_code == 200, resp.get_data(as_text=True)
    row = next(r for r in client.get(_url(test_store_id), headers=admin)
               .get_json()["rows"] if r["company"] == "Intermex")
    assert row["saved_debit_card"] == 60.0
    assert row["saved_payouts"] == 400.0
    assert row["saved_total"] == pytest.approx(600.0)
    assert _report(test_store_id).money_transfer == pytest.approx(600.0)


def test_older_clients_save_exactly_as_before(client, test_store_id, admin):
    """A body without the new fields (the SPA before this change, the
    Intermex import) is still valid and nets nothing off."""
    resp = client.put(_url(test_store_id), headers=admin,
                      json={"rows": [INTERMEX]})
    assert resp.status_code == 200
    assert _report(test_store_id).money_transfer == pytest.approx(1060.0)


def test_put_refuses_negative_and_over_card(client, test_store_id, admin):
    neg = client.put(_url(test_store_id), headers=admin,
                     json={"rows": [{**INTERMEX, "payouts": -1}]})
    assert neg.status_code == 422
    over = client.put(_url(test_store_id), headers=admin,
                      json={"rows": [{**INTERMEX, "debit_card": 2000}]})
    assert over.status_code == 422
    assert "more than the amount" in over.get_data(as_text=True)
    assert _saved(test_store_id) == {}


def test_put_on_a_locked_day_is_refused(client, test_store_id, admin):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        db.session.add(DailyReport(store_id=test_store_id, report_date=DAY,
                                   locked_at=datetime.utcnow()))
        db.session.commit()
    resp = client.put(_url(test_store_id), headers=admin, json={
        "rows": [{**INTERMEX, "payouts": 100.0}],
    })
    assert resp.status_code == 403
    assert _saved(test_store_id) == {}


def test_only_book_editors_can_save_them(client, test_store_id, admin):
    from api.Core.Permissions import set_user_permissions
    from api.Modules.Tenancy.Models import User

    def employee(username, matrix):
        with db_session():
            u = User(store_id=test_store_id, username=username,
                     role="employee", is_active=True)
            u.set_password("emppass1234")
            db.session.add(u)
            db.session.commit()
            uid = u.id
        set_user_permissions(test_store_id, uid, matrix)
        return _h(login_employee(client, test_store_id, username,
                                 "emppass1234"))

    body = {"rows": [{**INTERMEX, "debit_card": 10.0, "payouts": 20.0}]}
    reader = employee("dc_ro", {"daily_book": {"read": True}})
    assert client.put(_url(test_store_id), headers=reader,
                      json=body).status_code == 403
    assert _saved(test_store_id) == {}
    writer = employee("dc_rw", {"daily_book": {"read": True, "update": True}})
    assert client.put(_url(test_store_id), headers=writer,
                      json=body).status_code == 200
    assert _saved(test_store_id) == {"Intermex": (1000, 2000)}


def test_audit_names_a_company_with_only_payouts(client, test_store_id, admin):
    from api.Modules.Audit.Models import OperatorAuditLog
    client.put(_url(test_store_id), headers=admin, json={"rows": [
        {"company": "Maxi", "payouts": 75.0},
    ]})
    with db_session():
        row = (db.session.query(OperatorAuditLog)
                 .filter_by(store_id=test_store_id,
                            action="replace_mt_breakdown")
                 .order_by(OperatorAuditLog.id.desc()).first())
    assert "companies=Maxi" in (row.summary or "")
    assert _report(test_store_id).money_transfer == pytest.approx(-75.0)


# ── Intermex import keeps them ─────────────────────────────


def test_intermex_import_keeps_saved_debit_card_and_payouts(test_store_id):
    """The import knows only giros: it must not wipe what the operator
    typed for debit card / payouts, on Intermex or on another company."""
    from api.Modules.DailyBook.Services import (
        MTWriteRow, read_mt_breakdown, replace_mt_breakdown,
    )
    from api.Modules.ReportImport.Services.commit import (
        commit_intermex_to_mt_breakdown,
    )

    class _Giro:
        def __init__(self, send, fee, tax):
            self.send_amount, self.fee, self.federal_tax = send, fee, tax

    class _Report:
        active_giros = [_Giro(500.0, 10.0, 5.0)]
        all_reconcile = True

    with db_session():
        replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[
                MTWriteRow(company="Intermex", amount=400, fees=8,
                           federal_tax=4, commission=0,
                           debit_card=100, payouts=50),
                MTWriteRow(company="Maxi", amount=0, fees=0, federal_tax=0,
                           commission=0, payouts=30),
            ],
        )
        commit_intermex_to_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            report=_Report(),  # type: ignore[arg-type]
        )
        db.session.commit()
        rows = {r.company: r for r in
                read_mt_breakdown(db.session, test_store_id, DAY).rows}
    assert rows["Intermex"].saved_amount == 500
    assert (rows["Intermex"].saved_debit_card,
            rows["Intermex"].saved_payouts) == (100, 50)
    # A company with only payouts saved is still carried over.
    assert rows["Maxi"].saved_payouts == 30
    assert _report(test_store_id).money_transfer == pytest.approx(
        515 - 100 - 50 - 30)
