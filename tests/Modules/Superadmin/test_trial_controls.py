"""Giving out trials is a superadmin's everyday control; the
arithmetic must do what the button says.

Before this file: "+14 days" on a store whose trial ended two
months ago added 14 days to the OLD end, so the store stayed
expired and the superadmin saw "extended" in the audit log. The
rules pinned here: an extension counts from today when the trial
already ended, an explicit end date is accepted, reviving an
inactive store clears its retention timer, and moving a store's
plan off "inactive" through the edit form does the same.
"""
from datetime import date, datetime, timedelta

import pytest

from tests._app import db, db_session
from tests.conftest import login_superadmin


@pytest.fixture
def sa_token(client):
    return login_superadmin(client)


@pytest.fixture
def sa_headers(sa_token):
    return {"Authorization": f"Bearer {sa_token}"}


def _mk_store(**overrides):
    from api.Modules.Tenancy.Models import Store
    stamp = datetime.utcnow().timestamp()
    fields = dict(
        name="Trial Store", slug=f"trial-{stamp}", plan="trial",
        trial_ends_at=datetime.utcnow() + timedelta(days=3),
        grace_ends_at=datetime.utcnow() + timedelta(days=7),
    )
    fields.update(overrides)
    with db_session():
        s = Store(**fields)
        db.session.add(s)
        db.session.commit()
        return s.id


def _store(sid):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = db.session.get(Store, sid)
        return {
            "plan": s.plan, "trial_ends_at": s.trial_ends_at,
            "grace_ends_at": s.grace_ends_at,
            "data_retention_until": s.data_retention_until,
            "canceled_at": s.canceled_at,
            "trial_reminder_sent_at": s.trial_reminder_sent_at,
        }


def _extend(client, sa_headers, sid, **body):
    return client.post(
        f"/api/v2/superadmin/stores/{sid}/extend-trial",
        headers=sa_headers, json=body,
    )


class TestExtendTrial:
    def test_running_trial_extends_from_its_end(self, client, sa_headers):
        end = datetime.utcnow() + timedelta(days=3)
        sid = _mk_store(trial_ends_at=end)
        resp = _extend(client, sa_headers, sid, days=14)
        assert resp.status_code == 200, resp.text
        new_end = _store(sid)["trial_ends_at"]
        assert abs((new_end - (end + timedelta(days=14))).total_seconds()) < 5
        assert resp.json()["trial_status"] == "active"

    def test_expired_trial_extends_from_today(self, client, sa_headers):
        sid = _mk_store(
            trial_ends_at=datetime.utcnow() - timedelta(days=60),
            grace_ends_at=datetime.utcnow() - timedelta(days=56),
        )
        resp = _extend(client, sa_headers, sid, days=14)
        assert resp.status_code == 200, resp.text
        after = _store(sid)
        expected = datetime.utcnow() + timedelta(days=14)
        assert abs((after["trial_ends_at"] - expected).total_seconds()) < 5
        # The grace window follows the new end, so the store is
        # really usable again rather than still "expired".
        assert after["grace_ends_at"] > after["trial_ends_at"]
        assert resp.json()["trial_status"] == "active"

    def test_explicit_end_date(self, client, sa_headers):
        sid = _mk_store()
        target = date.today() + timedelta(days=45)
        resp = _extend(client, sa_headers, sid, ends_on=target.isoformat())
        assert resp.status_code == 200, resp.text
        assert _store(sid)["trial_ends_at"].date() == target
        assert resp.json()["trial_ends_at"].startswith(target.isoformat())

    def test_end_date_in_the_past_is_refused(self, client, sa_headers):
        sid = _mk_store()
        before = _store(sid)["trial_ends_at"]
        resp = _extend(
            client, sa_headers, sid,
            ends_on=(date.today() - timedelta(days=1)).isoformat(),
        )
        assert resp.status_code == 422
        assert _store(sid)["trial_ends_at"] == before

    def test_days_out_of_range_is_a_422_not_a_crash(self, client, sa_headers):
        sid = _mk_store()
        assert _extend(client, sa_headers, sid, days=0).status_code == 422
        assert _extend(client, sa_headers, sid, days=400).status_code == 422
        assert _extend(client, sa_headers, sid, days="soon").status_code == 422

    def test_default_is_fourteen_days(self, client, sa_headers):
        end = datetime.utcnow() + timedelta(days=1)
        sid = _mk_store(trial_ends_at=end)
        resp = _extend(client, sa_headers, sid)
        assert resp.status_code == 200, resp.text
        new_end = _store(sid)["trial_ends_at"]
        assert abs((new_end - (end + timedelta(days=14))).total_seconds()) < 5

    def test_reviving_an_inactive_store_clears_its_retention_timer(
        self, client, sa_headers,
    ):
        sid = _mk_store(
            plan="inactive",
            trial_ends_at=datetime.utcnow() - timedelta(days=200),
            grace_ends_at=datetime.utcnow() - timedelta(days=196),
            data_retention_until=datetime.utcnow() + timedelta(days=10),
            canceled_at=datetime.utcnow() - timedelta(days=190),
            trial_reminder_sent_at=datetime.utcnow() - timedelta(days=205),
        )
        resp = _extend(client, sa_headers, sid, days=30)
        assert resp.status_code == 200, resp.text
        after = _store(sid)
        assert after["plan"] == "trial"
        assert after["data_retention_until"] is None
        assert after["canceled_at"] is None
        # Reminder emails fire again for the new window.
        assert after["trial_reminder_sent_at"] is None
        assert resp.json()["trial_status"] == "active"

    def test_paid_store_is_refused(self, client, sa_headers):
        sid = _mk_store(plan="pro", trial_ends_at=None, grace_ends_at=None)
        resp = _extend(client, sa_headers, sid, days=14)
        assert resp.status_code == 409
        assert _store(sid)["plan"] == "pro"


class TestBulkExtendTrial:
    def test_bulk_uses_the_same_arithmetic(self, client, sa_headers):
        expired = _mk_store(
            trial_ends_at=datetime.utcnow() - timedelta(days=30),
            grace_ends_at=datetime.utcnow() - timedelta(days=26),
        )
        inactive = _mk_store(
            plan="inactive",
            trial_ends_at=datetime.utcnow() - timedelta(days=90),
            grace_ends_at=None,
            data_retention_until=datetime.utcnow() + timedelta(days=30),
        )
        resp = client.post(
            "/api/v2/superadmin/bulk-action", headers=sa_headers,
            json={"store_ids": [expired, inactive], "action": "extend_trial",
                  "days": 10},
        )
        assert resp.status_code == 200, resp.text
        expected = datetime.utcnow() + timedelta(days=10)
        for sid in (expired, inactive):
            after = _store(sid)
            assert abs((after["trial_ends_at"] - expected).total_seconds()) < 5
            assert after["plan"] == "trial"
            assert after["data_retention_until"] is None

    def test_bulk_days_is_validated(self, client, sa_headers):
        sid = _mk_store()
        resp = client.post(
            "/api/v2/superadmin/bulk-action", headers=sa_headers,
            json={"store_ids": [sid], "action": "extend_trial", "days": 0},
        )
        assert resp.status_code == 422


class TestPlanEdits:
    def test_moving_off_inactive_clears_retention(self, client, sa_headers):
        sid = _mk_store(
            plan="inactive", trial_ends_at=None, grace_ends_at=None,
            data_retention_until=datetime.utcnow() + timedelta(days=5),
            canceled_at=datetime.utcnow() - timedelta(days=175),
        )
        resp = client.patch(
            f"/api/v2/superadmin/stores/{sid}", headers=sa_headers,
            json={"plan": "pro"},
        )
        assert resp.status_code == 200, resp.text
        after = _store(sid)
        assert after["plan"] == "pro"
        assert after["data_retention_until"] is None
        assert after["canceled_at"] is None

    def test_plan_trial_on_an_elapsed_window_opens_a_new_one(
        self, client, sa_headers,
    ):
        sid = _mk_store(
            plan="basic",
            trial_ends_at=datetime.utcnow() - timedelta(days=40),
            grace_ends_at=datetime.utcnow() - timedelta(days=36),
        )
        resp = client.patch(
            f"/api/v2/superadmin/stores/{sid}", headers=sa_headers,
            json={"plan": "trial"},
        )
        assert resp.status_code == 200, resp.text
        after = _store(sid)
        assert after["plan"] == "trial"
        assert after["trial_ends_at"] > datetime.utcnow() + timedelta(days=13)
        assert after["grace_ends_at"] > after["trial_ends_at"]
        from api.Modules.Billing.Services.trial import get_trial_status
        from api.Modules.Tenancy.Models import Store
        with db_session():
            assert get_trial_status(db.session.get(Store, sid)) == "active"

    def test_plan_trial_keeps_a_running_window(self, client, sa_headers):
        end = datetime.utcnow() + timedelta(days=5)
        sid = _mk_store(plan="basic", trial_ends_at=end)
        resp = client.patch(
            f"/api/v2/superadmin/stores/{sid}", headers=sa_headers,
            json={"plan": "trial"},
        )
        assert resp.status_code == 200, resp.text
        assert abs((_store(sid)["trial_ends_at"] - end).total_seconds()) < 5
