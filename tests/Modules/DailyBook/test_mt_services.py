"""Bill payments, top-ups and recharges in the In column's Services box.

They live per company beside the money-transfer rows
(`msb_mt_service`), and the day's Services total — mirrored into
`DailyReport.money_transfer` — is transfers + services, so a
provider's total matches its cash drop. See INVARIANTS.md "Services".
"""
from datetime import date, datetime, timedelta
from typing import get_args

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee

DAY = date.today() - timedelta(days=2)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def admin(client, test_store_id):
    return _h(login_admin(client, test_store_id))


def _url(sid, d=DAY):
    return f"/api/v2/daily/{sid}/{d.isoformat()}/mt-breakdown"


MAXI_TRANSFERS = {"company": "Maxi", "amount": 800.0, "fees": 40.0,
                  "federal_tax": 8.0, "commission": 0.0}
MAXI_BILL = {"company": "Maxi", "service": "bill_payment",
             "amount": 120.0, "fees": 3.0}


def _report(sid, d=DAY):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        return (db.session.query(DailyReport)
                  .filter_by(store_id=sid, report_date=d).first())


def _service_rows(sid, d=DAY):
    from api.Modules.DailyBook.Models import MoneyServiceSummary
    with db_session():
        return {
            (r.company, r.service): (float(r.amount), float(r.fees))
            for r in db.session.query(MoneyServiceSummary)
                       .filter_by(store_id=sid, report_date=d)
        }


# ── Service layer ──────────────────────────────────────────


def test_services_save_and_count_in_the_day_total(test_store_id):
    from api.Modules.DailyBook.Services import (
        MTWriteRow, ServiceRow, read_mt_breakdown, replace_mt_breakdown,
    )
    with db_session():
        total = replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[MTWriteRow(company="Maxi", amount=800, fees=40,
                             federal_tax=8, commission=0)],
            services=[
                ServiceRow("Maxi", "recharge", 20, 1),
                ServiceRow("Maxi", "bill_payment", 120, 3),
                ServiceRow("Intermex", "top_up", 10, 0),
            ],
        )
        db.session.commit()
        breakdown = read_mt_breakdown(db.session, test_store_id, DAY)
    assert total == 848 + 123 + 21 + 10
    assert breakdown.saved_total == total
    assert _report(test_store_id).money_transfer == total
    # Tab order (bill payments, top-ups, recharges), then company.
    assert [(s.company, s.service) for s in breakdown.services] == [
        ("Maxi", "bill_payment"), ("Intermex", "top_up"), ("Maxi", "recharge"),
    ]


def test_transfers_only_caller_keeps_and_counts_services(test_store_id):
    """The Intermex import replaces transfer rows only — it must not
    drop the day's bill payments or leave them out of the total."""
    from api.Modules.DailyBook.Services import (
        MTWriteRow, ServiceRow, replace_mt_breakdown,
    )
    with db_session():
        replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[MTWriteRow("Maxi", 800, 40, 8, 0)],
            services=[ServiceRow("Maxi", "bill_payment", 120, 3)],
        )
        db.session.commit()
        total = replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[MTWriteRow("Maxi", 900, 45, 9, 0)],
        )
        db.session.commit()
    assert total == 954 + 123
    assert _service_rows(test_store_id) == {("Maxi", "bill_payment"): (120, 3)}
    assert _report(test_store_id).money_transfer == 1077


def test_empty_list_clears_and_zero_rows_are_skipped(test_store_id):
    from api.Modules.DailyBook.Services import (
        MTWriteRow, ServiceRow, replace_mt_breakdown,
    )
    with db_session():
        replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[MTWriteRow("Maxi", 100, 0, 0, 0)],
            services=[ServiceRow("Maxi", "bill_payment", 50, 2),
                      ServiceRow("Barri", "top_up", 0, 0)],
        )
        db.session.commit()
        assert _service_rows(test_store_id) == {("Maxi", "bill_payment"): (50, 2)}
        replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[MTWriteRow("Maxi", 100, 0, 0, 0)], services=[],
        )
        db.session.commit()
    assert _service_rows(test_store_id) == {}
    assert _report(test_store_id).money_transfer == 100


def test_duplicate_lines_for_one_company_merge(test_store_id):
    from api.Modules.DailyBook.Services import (
        ServiceRow, replace_mt_breakdown,
    )
    with db_session():
        replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY, rows=[],
            services=[ServiceRow(" Maxi ", "top_up", 10, 1),
                      ServiceRow("Maxi", "top_up", 5, 0)],
        )
        db.session.commit()
    assert _service_rows(test_store_id) == {("Maxi", "top_up"): (15, 1)}


def test_unknown_service_is_refused(test_store_id):
    from api.Modules.DailyBook.Services import (
        ServiceRow, UnknownServiceError, replace_mt_breakdown,
    )
    with db_session():
        with pytest.raises(UnknownServiceError):
            replace_mt_breakdown(
                db.session, store_id=test_store_id, report_date=DAY, rows=[],
                services=[ServiceRow("Maxi", "lottery", 10, 0)],
            )


def test_company_with_only_a_service_gets_a_row(test_store_id):
    """A service saved under a company that is no longer configured
    still shows a row so the box can display and clear it."""
    from api.Modules.DailyBook.Services import (
        ServiceRow, read_mt_breakdown, replace_mt_breakdown,
    )
    with db_session():
        replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY, rows=[],
            services=[ServiceRow("Ria", "bill_payment", 30, 1)],
        )
        db.session.commit()
        companies = [r.company for r in
                     read_mt_breakdown(db.session, test_store_id, DAY).rows]
    assert companies[-1] == "Ria"


def test_service_keys_match_the_request_schema():
    from api.Modules.DailyBook.Requests.reports import ServiceKind
    from api.Modules.DailyBook.Services import SERVICE_KINDS
    assert set(get_args(ServiceKind)) == set(SERVICE_KINDS)


def test_existing_day_without_services_is_unchanged(test_store_id):
    """A day saved before services existed reads exactly as before."""
    from api.Modules.DailyBook.Services import (
        MTWriteRow, read_mt_breakdown, replace_mt_breakdown,
    )
    with db_session():
        replace_mt_breakdown(
            db.session, store_id=test_store_id, report_date=DAY,
            rows=[MTWriteRow("Maxi", 800, 40, 8, 0)],
        )
        db.session.commit()
        breakdown = read_mt_breakdown(db.session, test_store_id, DAY)
    assert breakdown.services == []
    assert breakdown.saved_total == 848


# ── HTTP ───────────────────────────────────────────────────


def test_put_and_get_round_trip(client, test_store_id, admin):
    resp = client.put(_url(test_store_id), headers=admin, json={
        "rows": [MAXI_TRANSFERS], "services": [MAXI_BILL],
    })
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json()
    assert body["services"] == [MAXI_BILL]
    assert body["saved_total"] == 848 + 123

    got = client.get(_url(test_store_id), headers=admin).get_json()
    assert got["services"] == [MAXI_BILL]
    day = client.get(
        f"/api/v2/daily/{test_store_id}/{DAY.isoformat()}", headers=admin,
    ).get_json()["report"]
    assert day["money_transfer"] == 971
    assert day["total_receipts"] == 971


def test_put_without_services_leaves_them(client, test_store_id, admin):
    client.put(_url(test_store_id), headers=admin, json={
        "rows": [MAXI_TRANSFERS], "services": [MAXI_BILL],
    })
    resp = client.put(_url(test_store_id), headers=admin,
                      json={"rows": [MAXI_TRANSFERS]})
    assert resp.status_code == 200
    assert resp.get_json()["services"] == [MAXI_BILL]


def test_put_rejects_unknown_service(client, test_store_id, admin):
    resp = client.put(_url(test_store_id), headers=admin, json={
        "rows": [], "services": [{**MAXI_BILL, "service": "lottery"}],
    })
    assert resp.status_code == 422
    assert _service_rows(test_store_id) == {}


def test_put_refuses_locked_day(client, test_store_id, admin):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        db.session.add(DailyReport(store_id=test_store_id, report_date=DAY,
                                   locked_at=datetime.utcnow()))
        db.session.commit()
    resp = client.put(_url(test_store_id), headers=admin, json={
        "rows": [], "services": [MAXI_BILL],
    })
    assert resp.status_code == 403
    assert _service_rows(test_store_id) == {}


def test_put_is_audited(client, test_store_id, admin):
    from api.Modules.Audit.Models import OperatorAuditLog
    client.put(_url(test_store_id), headers=admin, json={
        "rows": [MAXI_TRANSFERS], "services": [MAXI_BILL],
    })
    with db_session():
        row = (db.session.query(OperatorAuditLog)
                 .filter_by(store_id=test_store_id,
                            action="replace_mt_breakdown")
                 .order_by(OperatorAuditLog.id.desc()).first())
    assert "services=Maxi:bill_payment" in (row.summary or "")


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


def test_reader_sees_services_but_cannot_save(client, test_store_id, admin):
    client.put(_url(test_store_id), headers=admin, json={
        "rows": [], "services": [MAXI_BILL],
    })
    reader = _employee(client, test_store_id, "svc_ro",
                       {"daily_book": {"read": True}})
    assert client.get(_url(test_store_id), headers=reader).get_json()[
        "services"] == [MAXI_BILL]
    resp = client.put(_url(test_store_id), headers=reader,
                      json={"rows": [], "services": []})
    assert resp.status_code == 403
    assert _service_rows(test_store_id) == {("Maxi", "bill_payment"): (120, 3)}

    writer = _employee(client, test_store_id, "svc_rw",
                       {"daily_book": {"read": True, "update": True}})
    resp = client.put(_url(test_store_id), headers=writer,
                      json={"rows": [], "services": []})
    assert resp.status_code == 200
    assert _service_rows(test_store_id) == {}


def test_no_book_access_gets_nothing(client, test_store_id, admin):
    nobody = _employee(client, test_store_id, "svc_none",
                       {"time_clock": {"read": True}})
    assert client.get(_url(test_store_id), headers=nobody).status_code == 403


# ── Money orders (a service per company) ───────────────────


MAXI_MO = {"company": "Maxi", "service": "money_order",
           "amount": 400.0, "fees": 6.0}


def _set_money_orders_off(sid, csv):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        db.session.get(Store, sid).companies_money_orders_off = csv
        db.session.commit()


def test_money_orders_save_per_company_and_count(client, test_store_id, admin):
    """Money orders ride the services table: they count in the day's
    Services total, in Money In, and in the company's own total."""
    resp = client.put(_url(test_store_id), headers=admin, json={
        "rows": [MAXI_TRANSFERS], "services": [MAXI_BILL, MAXI_MO],
    })
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.get_json()["saved_total"] == 848 + 123 + 406
    assert _service_rows(test_store_id)[("Maxi", "money_order")] == (400, 6)
    day = client.get(
        f"/api/v2/daily/{test_store_id}/{DAY.isoformat()}", headers=admin,
    ).get_json()["report"]
    assert day["money_transfer"] == 1377
    assert day["total_receipts"] == 1377
    # The money order fee is not double-counted in the old field.
    assert day["money_order"] == 0 and day["money_order_fees"] == 0


def test_money_order_companies_follow_the_settings_switch(
    client, test_store_id, admin,
):
    got = client.get(_url(test_store_id), headers=admin).get_json()
    assert got["money_order_companies"] == [r["company"] for r in got["rows"]]

    _set_money_orders_off(test_store_id, "Maxi")
    got = client.get(_url(test_store_id), headers=admin).get_json()
    assert "Maxi" not in got["money_order_companies"]
    assert "Maxi" in [r["company"] for r in got["rows"]]

    _set_money_orders_off(test_store_id, ",".join(
        r["company"] for r in got["rows"]))
    got = client.get(_url(test_store_id), headers=admin).get_json()
    assert got["money_order_companies"] == []


def test_switched_off_company_keeps_its_saved_money_orders(
    client, test_store_id, admin,
):
    """Turning a company's money orders off later never loses a day
    that already has them: the row still reads back and counts."""
    client.put(_url(test_store_id), headers=admin, json={
        "rows": [], "services": [MAXI_MO],
    })
    _set_money_orders_off(test_store_id, "Maxi")
    got = client.get(_url(test_store_id), headers=admin).get_json()
    assert got["services"] == [MAXI_MO]
    assert got["saved_total"] == 406


def test_older_money_order_entries_and_fee_still_count(
    client, test_store_id, admin,
):
    """A day from before this change (money order line items + the
    typed money order fee) reads and totals exactly as before, and
    adding per-company money orders on top adds, never replaces."""
    from api.Modules.DailyBook.Models import DailyLineItem, DailyReport
    with db_session():
        db.session.add(DailyReport(store_id=test_store_id, report_date=DAY,
                                   money_order=250.0, money_order_fees=5.0))
        db.session.add(DailyLineItem(store_id=test_store_id, report_date=DAY,
                                     kind="money_order", amount=250.0))
        db.session.commit()
    day_url = f"/api/v2/daily/{test_store_id}/{DAY.isoformat()}"
    before = client.get(day_url, headers=admin).get_json()["report"]
    assert before["total_receipts"] == 255

    client.put(_url(test_store_id), headers=admin, json={
        "rows": [], "services": [MAXI_MO],
    })
    after = client.get(day_url, headers=admin).get_json()["report"]
    assert after["money_order"] == 250 and after["money_order_fees"] == 5
    assert after["total_receipts"] == 255 + 406


def test_money_orders_refused_on_a_locked_day(client, test_store_id, admin):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        db.session.add(DailyReport(store_id=test_store_id, report_date=DAY,
                                   locked_at=datetime.utcnow()))
        db.session.commit()
    resp = client.put(_url(test_store_id), headers=admin, json={
        "rows": [], "services": [MAXI_MO],
    })
    assert resp.status_code == 403
    assert _service_rows(test_store_id) == {}


def test_reader_cannot_save_money_orders(client, test_store_id, admin):
    reader = _employee(client, test_store_id, "mo_ro",
                       {"daily_book": {"read": True}})
    resp = client.put(_url(test_store_id), headers=reader,
                      json={"rows": [], "services": [MAXI_MO]})
    assert resp.status_code == 403
    assert _service_rows(test_store_id) == {}
