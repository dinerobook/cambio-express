"""The superadmin answers with every list filled in.

Each of these routes documents its answer with a model
(``Superadmin.Requests.responses``) while still sending the dict it
always built. conftest checks every answer against its model, but a
list that is empty in every other test proves nothing about its rows —
so here each list carries at least one row: stores in every billing
state, a referrer, transfers, email events, a bounced address, a
roster, a store with its own permission rows, a sent email, and Stripe
/ SMTP health on both the success and the failure branch.
"""
from datetime import timedelta
from unittest.mock import patch

import pytest

from api.Core.Clock import utc_now
from tests._app import db, db_session
from tests.conftest import login_superadmin, seed_transfer

SA = "/api/v2/superadmin"


@pytest.fixture
def h(client):
    return {"Authorization": f"Bearer {login_superadmin(client)}"}


def _stores():
    """One store per billing-overview list, the test store as a
    referrer with a redeemed code, transfers, a roster and a bounced
    admin email. Returns the test store's id."""
    from api.Modules.Billing.Models import ReferralCode
    from api.Modules.Tenancy.Models import Store, StoreEmployee, User
    from api.Modules.Webhooks.Models import EmailEvent
    now = utc_now()
    with db_session():
        home = db.session.query(Store).filter_by(slug="test-store").one()
        home.trial_ends_at = now + timedelta(days=2)       # expiring soon
        db.session.add_all([
            Store(name="Grace", slug="grace", plan="trial",
                  trial_ends_at=now - timedelta(days=1),
                  grace_ends_at=now + timedelta(days=3)),
            Store(name="Gone", slug="gone", plan="inactive",
                  canceled_at=now - timedelta(days=2),
                  data_retention_until=now + timedelta(days=80)),
            Store(name="Expired", slug="expired", plan="inactive",
                  canceled_at=now - timedelta(days=200),
                  data_retention_until=now - timedelta(days=1)),
        ])
        db.session.add(ReferralCode(code="TESTREF", owner_store_id=home.id,
                                    redeemed_count=2))
        db.session.add(StoreEmployee(store_id=home.id, name="Ana"))
        admin = db.session.query(User).filter_by(store_id=home.id).first()
        admin.email = "admin@test.com"
        admin.email_bounced_at = now
        db.session.add(EmailEvent(message_id="m1", to_addr="admin@test.com",
                                  event_type="email.bounced",
                                  bounce_type="hard", user_id=admin.id))
        db.session.commit()
        sid, admin_id = home.id, admin.id
    seed_transfer(sid, admin_id)
    return sid


def test_dashboard_lists_carry_rows(client, h):
    _stores()
    data = client.get(f"{SA}/dashboard", headers=h).json()
    assert data["top_referrers"][0]["code"] == "TESTREF"
    assert data["volume_by_company"][0]["company"] == "Intermex"
    assert {a["kind"] for a in data["activity"]} == {"signup", "cancel"}
    assert len(data["mrr_trend"]["labels"]) == 12


def test_billing_overview_every_list(client, h):
    _stores()
    data = client.get(f"{SA}/billing-overview", headers=h).json()
    assert data["expiring_soon"][0]["trial_ends_at"]
    assert data["in_grace"][0]["grace_ends_at"]
    assert data["retention_queue"][0]["days_left"] >= 79
    assert data["recent_cancels"][0]["canceled_at"]


def test_email_log_rows_and_suppressed(client, h):
    _stores()
    data = client.get(f"{SA}/email-log", headers=h).json()
    assert data["rows"][0]["bounce_type"] == "hard"
    assert data["suppressed"][0]["email"] == "admin@test.com"


def test_store_drill_with_roster_and_transfers(client, h):
    sid = _stores()
    data = client.get(f"{SA}/stores/{sid}/drill", headers=h).json()
    assert data["roster"][0]["name"] == "Ana"
    assert data["recent_transfers"][0]["company"] == "Intermex"
    assert data["stats_30d"]["transfer_count"] == 1


def test_retention_dry_run_lists_the_expired_store(client, h):
    _stores()
    data = client.get(f"{SA}/retention-dry-run", headers=h).json()
    assert [s["slug"] for s in data["stores"]] == ["expired"]


def test_store_permissions_with_overrides(client, h):
    sid = _stores()
    grid = client.get(f"{SA}/stores/{sid}/permissions", headers=h).json()
    employee = grid["matrix"]["employee"]
    employee["reports"]["read"] = not employee["reports"]["read"]
    data = client.put(f"{SA}/stores/{sid}/permissions", headers=h,
                      json={"matrix": {"employee": employee}}).json()
    assert data["has_overrides"] == ["employee"]
    assert data["store_name"] == "Test Store"


def test_store_email_lists_who_got_it(client, h):
    sid = _stores()
    with patch("api.Modules.Notifications.Services.smtp.send_email",
               return_value=True):
        data = client.post(f"{SA}/stores/{sid}/email", headers=h,
                           json={"subject": "Hi", "message": "Hello"}).json()
    assert data == {"ok": True, "sent_to": ["admin@test.com"], "total": 1}


def test_bulk_extend_trial_reports_skips(client, h):
    sid = _stores()
    from api.Modules.Tenancy.Models import Store
    with db_session():
        paid = Store(name="Paid", slug="paid", plan="pro")
        db.session.add(paid)
        db.session.commit()
        paid_id = paid.id
    data = client.post(f"{SA}/bulk-action", headers=h, json={
        "store_ids": [sid, paid_id], "action": "extend_trial", "days": 7,
    }).json()
    by_id = {r["store_id"]: r for r in data["results"]}
    assert by_id[sid]["trial_ends_at"]
    assert by_id[paid_id]["skipped"]


def test_system_health_when_stripe_and_smtp_answer(client, h):
    stripe_ok = {
        "env": {"secret_key": True}, "ok": True, "error": "",
        "price_ok": {"basic": True}, "price_errors": {"basic": ""},
        "fc_ok": True, "fc_error": "", "key_pair_match": True,
        "account_id": "acct_1", "account_email": "a@b.co", "mode": "test",
    }
    smtp_ok = {"configured": True, "status": "ok", "error": "",
               "recent_events": {"sent": 1}, "suppressed_count": 0,
               "last_event_at": utc_now()}
    with patch("api.Modules.Billing.Services.health.check_stripe_integration",
               return_value=stripe_ok), \
         patch("api.Modules.Notifications.Services.smtp.health_check",
               return_value=smtp_ok):
        data = client.get(f"{SA}/system-health", headers=h).json()
    assert data["stripe"]["mode"] == "test"
    assert data["email"]["last_event_at"]


def test_system_health_when_stripe_and_smtp_fail(client, h):
    with patch("api.Modules.Billing.Services.health.check_stripe_integration",
               side_effect=RuntimeError("down")), \
         patch("api.Modules.Notifications.Services.smtp.health_check",
               side_effect=RuntimeError("down")):
        data = client.get(f"{SA}/system-health", headers=h).json()
    assert data["stripe"] == {"ok": False, "error": "down"}
    assert data["email"] == {"configured": False, "error": "down"}
