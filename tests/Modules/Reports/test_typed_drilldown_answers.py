"""Report drilldowns whose answers no other test fills.

conftest checks every answer against the route's documented model
(``Reports.Requests.drilldowns``), but only rows that exist get
checked: these give the period P&L a daily report and the high-value
report a transfer over its threshold.
"""
from datetime import date

from tests._app import db, db_session
from tests.conftest import login_admin, seed_transfer

DAY = date(2026, 9, 15)
RANGE = "from=2026-09-01&to=2026-09-30"


def _get(client, store_id, slug, extra=""):
    token = login_admin(client, store_id)
    return client.get(
        f"/api/v2/reports/{slug}?store_ids={store_id}&{RANGE}{extra}",
        headers={"Authorization": f"Bearer {token}"},
    )


def test_period_pl_lists_income_and_expense_lines(client, test_store_id, test_admin_id):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        db.session.add(DailyReport(store_id=test_store_id, report_date=DAY,
                                   taxable_sales=500.0, cash_expense=120.0))
        db.session.commit()
    seed_transfer(test_store_id, test_admin_id, send_date=DAY, fee=8.0)
    resp = _get(client, test_store_id, "period-pl")
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.json()
    lines = {r["label"]: r for r in body["rows"]}
    assert lines["Taxable Sales"] == {"label": "Taxable Sales", "section": "Income", "amount": 500.0}
    assert lines["Money Transfer Fees"]["amount"] == 8.0
    assert lines["Cash Expenses"]["section"] == "Expenses"
    assert body["totals"] == {"income": 508.0, "expenses": 120.0, "net": 388.0, "days": 1}


def test_period_pl_refuses_a_caller_without_reports(client, test_store_id):
    resp = client.get(f"/api/v2/reports/period-pl?store_ids={test_store_id}&{RANGE}")
    assert resp.status_code in (401, 403)


def test_high_value_transfers_lists_the_big_send(client, test_store_id, test_admin_id):
    seed_transfer(test_store_id, test_admin_id, send_date=DAY, send_amount=2500.0)
    seed_transfer(test_store_id, test_admin_id, send_date=DAY, send_amount=50.0)
    resp = _get(client, test_store_id, "high-value-transfers", "&threshold=1000")
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.json()
    assert [r["amount"] for r in body["rows"]] == [2500.0]
    assert body["rows"][0]["send_date"] == "2026-09-15"
    assert body["totals"]["count"] == 1
