"""The admin dashboard's "Net income (month)" KPI is the store's
Monthly P&L net — the same number /monthly shows — not the legacy
``MonthlyFinancial.net_income`` property (which drops
``bank_charges_total`` and the profit distribution)."""
from tests._app import db, db_session
from tests.conftest import login_admin


def _seed_month(store_id, year, month):
    from api.Modules.Monthly.Models import MonthlyFinancial
    with db_session():
        db.session.add(MonthlyFinancial(
            store_id=store_id, year=year, month=month,
            taxable_sales=1000.0, bank_charges_total=100.0,
            over_short=50.0, profit_distributed=200.0,
        ))
        db.session.commit()


def test_dashboard_month_net_matches_monthly_pl(client, test_store_id):
    from api.Core.Clock import local_today
    today = local_today("")
    _seed_month(test_store_id, today.year, today.month)
    h = {"Authorization": f"Bearer {login_admin(client, test_store_id)}"}
    monthly = client.get(
        f"/api/v2/monthly/{today.year}/{today.month}", headers=h,
    )
    assert monthly.status_code == 200, monthly.get_data(as_text=True)
    pl_net = monthly.get_json()["report"]["net_profit"]
    # 1000 income + 50 over − (100 bank + 200 distributed)
    assert pl_net == 750.0
    summary = client.get("/api/v2/dashboard/summary", headers=h).get_json()
    assert summary["kpis"]["net_income_month"] == pl_net


def test_dashboard_month_net_is_none_without_a_pl_row(client, test_store_id):
    h = {"Authorization": f"Bearer {login_admin(client, test_store_id)}"}
    summary = client.get("/api/v2/dashboard/summary", headers=h).get_json()
    assert summary["kpis"]["net_income_month"] is None
