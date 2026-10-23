"""The dashboard summary with every list filled in.

``GET /dashboard/summary`` documents one shape per role
(``Dashboard.Requests``) while still sending the dict it always built;
conftest checks every answer against it, but only rows that exist get
checked. These fill the lists no other test fills: ACH batches, bank
accounts, a day close's top departments, and an employee's transfers
for today.
"""
from datetime import date

from pydantic import TypeAdapter

from api.Modules.Dashboard.Requests import DashboardSummaryResponse
from tests._app import db, db_session
from tests._response_contract import shape_errors
from tests.conftest import login_admin, seed_transfer


def _get(client, token):
    resp = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_admin_summary_with_batches_and_bank_accounts(client, test_store_id):
    from api.Modules.BankSync.Models import StripeBankAccount
    from api.Modules.Batches.Models import ACHBatch
    with db_session():
        db.session.add(ACHBatch(
            store_id=test_store_id, ach_date=date(2026, 10, 1),
            company="Intermex", batch_ref="B-1", ach_amount=1500.0,
        ))
        db.session.add(StripeBankAccount(
            store_id=test_store_id, stripe_account_id="fca_1",
            display_name="Checking", institution_name="Chase",
            last4="1234",
        ))
        db.session.commit()
    data = _get(client, login_admin(client, test_store_id))
    assert data["role"] == "admin"
    assert data["recent_batches"][0]["ach_amount"] == 1500.0
    assert data["stripe_accounts"][0]["last4"] == "1234"


def test_admin_summary_with_a_day_close_by_department(client, test_store_id):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        db.session.get(Store, test_store_id).business_type = "cstore"
        db.session.commit()
    h = {"Authorization": f"Bearer {login_admin(client, test_store_id)}"}
    dept = client.post("/api/v2/dayclose/departments", headers=h,
                       json={"name": "Grocery", "sort_order": 0}).json()["department"]
    resp = client.post("/api/v2/dayclose/day/2026-08-20/closes", headers=h, json={
        "register_label": "Register 1", "gross_sales": 1000.0,
        "sales_tax": 80.0, "cash_total": 400.0, "card_total": 600.0,
        "other_total": 0.0,
        "department_sales": [{"department_id": dept["id"], "amount": 1000.0}],
    })
    assert resp.status_code == 200, resp.text
    data = client.get("/api/v2/dashboard/summary", headers=h).json()
    assert data["day_close"]["top_departments"] == [
        {"name": "Grocery", "amount": 1000.0},
    ]


def test_employee_summary_rows_match_the_documented_shape(
    client, test_store_id, test_admin_id,
):
    """An employee needs the money-services module switched on for
    them to see transfers; the builder is called directly with
    claims that can read them, and its answer checked like the
    contract checks an HTTP answer."""
    from api.Core.Clock import local_today
    from api.Modules.Dashboard.Controllers import _employee_summary
    seed_transfer(test_store_id, test_admin_id, send_date=local_today(None))
    claims = {"role": "admin", "store_id": test_store_id, "sub": str(test_admin_id)}
    with db_session():
        body = {"role": "employee",
                **_employee_summary(db.session, test_store_id, claims)}
    assert len(body["today_transfers"]) == 1
    import json
    wire = json.loads(json.dumps(body, default=str))
    TypeAdapter(DashboardSummaryResponse).validate_python(wire)
    assert shape_errors(DashboardSummaryResponse, wire) == []
