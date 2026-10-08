"""Comp plan: give a store a paid plan for free, and stop Stripe
from charging it meanwhile.

Before: the plan field on the edit form set ``plan`` but any Stripe
subscription kept billing, and nothing marked the store as comped.
"""
from datetime import datetime, timedelta
from unittest.mock import MagicMock

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
        name="Comp Store", slug=f"comp-{stamp}", plan="trial",
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
        return {k: getattr(s, k) for k in (
            "plan", "billing_cycle", "comped_at", "comp_reason",
            "stripe_subscription_id", "data_retention_until", "canceled_at",
        )}


def _stub_stripe(monkeypatch, *, modify_error=None, price_id="price_basic_m"):
    import stripe
    monkeypatch.setattr(stripe, "api_key", "sk_test_dummy", raising=False)
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_dummy")
    modify = MagicMock(side_effect=modify_error) if modify_error else MagicMock()
    monkeypatch.setattr(stripe.Subscription, "modify", modify)
    retrieve = MagicMock(return_value={
        "items": {"data": [{"price": {"id": price_id}}]},
    })
    monkeypatch.setattr(stripe.Subscription, "retrieve", retrieve)
    return modify, retrieve


def _comp(client, sa_headers, sid, **body):
    payload = {"plan": "pro", "reason": "beta partner"}
    payload.update(body)
    return client.post(
        f"/api/v2/superadmin/stores/{sid}/comp-plan",
        headers=sa_headers, json=payload,
    )


class TestComp:
    def test_comps_a_trial_store_without_stripe(self, client, sa_headers):
        sid = _mk_store()
        resp = _comp(client, sa_headers, sid)
        assert resp.status_code == 200, resp.text
        after = _store(sid)
        assert after["plan"] == "pro"
        assert after["billing_cycle"] == "comp"
        assert after["comped_at"] is not None
        assert after["comp_reason"] == "beta partner"
        body = resp.json()
        assert body["plan"] == "pro" and body["comped"] is True
        assert body["stripe_paused"] is False
        from api.Modules.Audit.Models import SuperadminAuditLog
        with db_session():
            row = (
                db.session.query(SuperadminAuditLog)
                .filter_by(action="comp_plan", target_id=str(sid)).first()
            )
            assert row is not None and "beta partner" in row.details

    def test_comps_a_cancelled_store_and_clears_retention(
        self, client, sa_headers,
    ):
        sid = _mk_store(
            plan="inactive",
            data_retention_until=datetime.utcnow() + timedelta(days=9),
            canceled_at=datetime.utcnow() - timedelta(days=171),
        )
        assert _comp(client, sa_headers, sid, plan="basic").status_code == 200
        after = _store(sid)
        assert after["plan"] == "basic"
        assert after["data_retention_until"] is None
        assert after["canceled_at"] is None

    def test_pauses_a_live_stripe_subscription(
        self, client, sa_headers, monkeypatch,
    ):
        modify, _ = _stub_stripe(monkeypatch)
        sid = _mk_store(plan="basic", billing_cycle="monthly",
                        stripe_subscription_id="sub_123",
                        trial_ends_at=None, grace_ends_at=None)
        resp = _comp(client, sa_headers, sid)
        assert resp.status_code == 200, resp.text
        assert resp.json()["stripe_paused"] is True
        modify.assert_called_once()
        args, kwargs = modify.call_args
        assert args[0] == "sub_123"
        assert kwargs["pause_collection"] == {"behavior": "void"}
        after = _store(sid)
        assert after["plan"] == "pro" and after["billing_cycle"] == "comp"
        # The subscription stays attached so the comp can be ended.
        assert after["stripe_subscription_id"] == "sub_123"

    def test_stripe_error_changes_nothing(self, client, sa_headers, monkeypatch):
        import stripe
        _stub_stripe(monkeypatch, modify_error=stripe.StripeError("boom"))
        sid = _mk_store(plan="basic", billing_cycle="monthly",
                        stripe_subscription_id="sub_123",
                        trial_ends_at=None, grace_ends_at=None)
        resp = _comp(client, sa_headers, sid)
        assert resp.status_code == 502
        after = _store(sid)
        assert after["plan"] == "basic" and after["comped_at"] is None

    def test_stripe_unconfigured_with_a_subscription_is_503(
        self, client, sa_headers, monkeypatch,
    ):
        import stripe
        monkeypatch.setattr(stripe, "api_key", "", raising=False)
        monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
        sid = _mk_store(plan="basic", stripe_subscription_id="sub_123",
                        trial_ends_at=None, grace_ends_at=None)
        resp = _comp(client, sa_headers, sid)
        assert resp.status_code == 503
        assert _store(sid)["comped_at"] is None

    def test_only_paid_plans_can_be_comped(self, client, sa_headers):
        sid = _mk_store()
        assert _comp(client, sa_headers, sid, plan="trial").status_code == 422
        assert _comp(client, sa_headers, sid, plan="inactive").status_code == 422

    def test_missing_store_is_404(self, client, sa_headers):
        assert _comp(client, sa_headers, 999999).status_code == 404


class TestEndComp:
    def _end(self, client, sa_headers, sid):
        return client.post(
            f"/api/v2/superadmin/stores/{sid}/end-comp", headers=sa_headers,
        )

    def test_resumes_stripe_and_restores_the_paid_plan(
        self, client, sa_headers, monkeypatch,
    ):
        modify, retrieve = _stub_stripe(monkeypatch, price_id="price_basic_m")
        from api.Modules.Billing.Services.webhook import derive_plan_from_price
        plan, cycle = derive_plan_from_price("price_basic_m")
        sid = _mk_store(plan="pro", billing_cycle="comp",
                        comped_at=datetime.utcnow(), comp_reason="x",
                        stripe_subscription_id="sub_123",
                        trial_ends_at=None, grace_ends_at=None)
        resp = self._end(client, sa_headers, sid)
        assert resp.status_code == 200, resp.text
        args, kwargs = modify.call_args
        assert args[0] == "sub_123"
        assert kwargs["pause_collection"] == ""
        after = _store(sid)
        assert after["comped_at"] is None and after["comp_reason"] == ""
        assert after["plan"] == plan and after["billing_cycle"] == cycle

    def test_without_a_subscription_the_store_goes_back_to_a_trial(
        self, client, sa_headers,
    ):
        sid = _mk_store(plan="pro", billing_cycle="comp",
                        comped_at=datetime.utcnow(), comp_reason="x",
                        trial_ends_at=None, grace_ends_at=None)
        resp = self._end(client, sa_headers, sid)
        assert resp.status_code == 200, resp.text
        after = _store(sid)
        assert after["plan"] == "trial"
        assert after["comped_at"] is None
        from api.Modules.Billing.Services.trial import get_trial_status
        from api.Modules.Tenancy.Models import Store
        with db_session():
            assert get_trial_status(db.session.get(Store, sid)) == "active"

    def test_not_comped_is_409(self, client, sa_headers):
        sid = _mk_store()
        assert self._end(client, sa_headers, sid).status_code == 409


class TestStripeEventsRespectAComp:
    def test_subscription_deleted_keeps_a_comped_store_on_its_plan(self):
        from api.Modules.Billing.Services.webhook import handle_stripe_event
        sid = _mk_store(plan="pro", billing_cycle="comp",
                        comped_at=datetime.utcnow(), comp_reason="x",
                        stripe_subscription_id="sub_gone",
                        trial_ends_at=None, grace_ends_at=None)
        with db_session():
            handle_stripe_event(db.session, {
                "type": "customer.subscription.deleted",
                "data": {"object": {"id": "sub_gone"}},
            })
        after = _store(sid)
        assert after["plan"] == "pro"
        assert after["comped_at"] is not None
        assert after["stripe_subscription_id"] == ""
        assert after["data_retention_until"] is None

    def test_checkout_completed_ends_the_comp(self, monkeypatch):
        _stub_stripe(monkeypatch, price_id="price_basic_m")
        from api.Modules.Billing.Services.webhook import handle_stripe_event
        sid = _mk_store(plan="pro", billing_cycle="comp",
                        comped_at=datetime.utcnow(), comp_reason="x",
                        trial_ends_at=None, grace_ends_at=None)
        with db_session():
            handle_stripe_event(db.session, {
                "type": "checkout.session.completed",
                "data": {"object": {
                    "metadata": {"store_id": str(sid)},
                    "subscription": "sub_new", "customer": "cus_new",
                }},
            })
        after = _store(sid)
        assert after["comped_at"] is None and after["comp_reason"] == ""
        assert after["stripe_subscription_id"] == "sub_new"


def test_drill_shows_the_comp(client, sa_headers):
    sid = _mk_store(plan="pro", billing_cycle="comp",
                    comped_at=datetime.utcnow(), comp_reason="beta partner",
                    trial_ends_at=None, grace_ends_at=None)
    resp = client.get(f"/api/v2/superadmin/stores/{sid}/drill", headers=sa_headers)
    assert resp.status_code == 200
    store = resp.json()["store"]
    assert store["comped"] is True
    assert store["comp_reason"] == "beta partner"
    assert store["comped_at"]
