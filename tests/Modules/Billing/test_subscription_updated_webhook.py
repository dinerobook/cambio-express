"""Stripe `customer.subscription.updated` → the store follows Stripe.

A customer who switches plan or cadence in the Stripe Billing Portal
(Pro monthly → Pro yearly, Pro → Basic) changes the price Stripe
bills. Before this handler the event was ignored, so a store moved to
yearly kept `billing_cycle = "monthly"` and the app went on calling it
"Pro, $45 / month" on its Subscribe and subscription pages.

Pinned here, through the real webhook route and database:
  - each portal move lands on the right `(plan, billing_cycle)`;
  - the LIVE subscription is what counts, not the event's snapshot
    (Stripe does not promise delivery order);
  - every doubt leaves the store exactly as it was: unknown price,
    comped store, store not on a paid plan, a non-billing status,
    Stripe unreachable, a subscription we don't know.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

from tests._app import db, db_session

PRICES = {
    "STRIPE_BASIC_PRICE_ID": "price_basic_m",
    "STRIPE_BASIC_YEARLY_PRICE_ID": "price_basic_y",
    "STRIPE_PRO_PRICE_ID": "price_pro_m",
    "STRIPE_PRO_YEARLY_PRICE_ID": "price_pro_y",
}


@pytest.fixture(autouse=True)
def _price_ids(monkeypatch):
    for k, v in PRICES.items():
        monkeypatch.setenv(k, v)


def _seed(plan="pro", cycle="monthly", sub_id="sub_upd", **kwargs):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = Store(name="Upd Store", slug=f"upd-{sub_id}", email="u@test.com",
                  plan=plan, billing_cycle=cycle,
                  stripe_subscription_id=sub_id, **kwargs)
        db.session.add(s)
        db.session.commit()
        return s.id


def _store(sid):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = db.session.get(Store, sid)
        return s.plan, s.billing_cycle


def _live(price_id, status="active"):
    return {"status": status,
            "items": {"data": [{"price": {"id": price_id}}]}}


def _post(client, sub_id="sub_upd", *, live=None, snapshot_price="price_pro_m"):
    """Deliver an `updated` event. `live` is what Stripe answers for
    the subscription now (a dict, or an exception to raise)."""
    event = {
        "id": "evt_upd",
        "type": "customer.subscription.updated",
        "data": {"object": {"id": sub_id, "status": "active", "items": {
            "data": [{"price": {"id": snapshot_price}}]}}},
    }
    retrieve = MagicMock()
    if isinstance(live, Exception):
        retrieve.side_effect = live
    else:
        retrieve.return_value = live
    with patch("stripe.Webhook.construct_event", return_value=event), \
            patch("stripe.Subscription.retrieve", retrieve):
        resp = client.post(
            "/api/v2/webhooks/stripe",
            data=json.dumps(event).encode(),
            headers={"Stripe-Signature": "valid",
                     "Content-Type": "application/json"},
        )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return retrieve


# ── Portal moves land on the plan Stripe bills ─────────────────────


@pytest.mark.parametrize("start,price,expected", [
    (("pro", "monthly"), "price_pro_y", ("pro", "yearly")),
    (("pro", "yearly"), "price_pro_m", ("pro", "monthly")),
    (("basic", "monthly"), "price_basic_y", ("basic", "yearly")),
    (("basic", "yearly"), "price_pro_y", ("pro", "yearly")),
    (("pro", "monthly"), "price_basic_m", ("basic", "monthly")),
])
def test_portal_switch_follows_the_live_price(client, start, price, expected):
    sid = _seed(*start)
    retrieve = _post(client, live=_live(price))
    retrieve.assert_called_once_with("sub_upd")
    assert _store(sid) == expected


def test_live_subscription_wins_over_a_stale_event(client):
    """An older event (monthly) delivered after the switch to yearly
    must not put the store back on monthly."""
    sid = _seed("pro", "yearly")
    _post(client, live=_live("price_pro_y"), snapshot_price="price_pro_m")
    assert _store(sid) == ("pro", "yearly")


def test_past_due_still_follows_the_price(client):
    sid = _seed("pro", "monthly")
    _post(client, live=_live("price_pro_y", status="past_due"))
    assert _store(sid) == ("pro", "yearly")


def test_the_subscription_page_reads_the_new_cadence(client, test_store_id):
    """End to end: after the event, the store's own summary says
    yearly — label, price and the catalog key the Subscribe page
    marks as current."""
    from api.Modules.Tenancy.Models import Store, User
    with db_session():
        s = db.session.get(Store, test_store_id)
        s.plan, s.billing_cycle = "pro", "monthly"
        s.stripe_subscription_id = "sub_mine"
        db.session.commit()
        assert db.session.query(User).filter_by(
            store_id=test_store_id, role="admin").first()
    _post(client, "sub_mine", live=_live("price_pro_y"))
    jwt = client.post("/api/v2/auth/login", json={
        "username": "admin@test.com", "password": "testpass123!",
        "store_id": test_store_id,
    }).get_json()["access_token"]
    with patch("stripe.Subscription.retrieve",
               return_value=MagicMock(cancel_at_period_end=False)):
        body = client.get(
            "/api/v2/admin/subscription",
            headers={"Authorization": f"Bearer {jwt}"},
        ).get_json()
    assert body["plan_key"] == "pro_yearly"
    assert body["plan_label"] == "Pro (yearly)"
    assert body["plan_price"] == "$450 / year"


# ── Every doubt leaves the store as it was ─────────────────────────


def test_unknown_price_changes_nothing(client):
    sid = _seed("basic", "monthly")
    _post(client, live=_live("price_someone_elses"))
    assert _store(sid) == ("basic", "monthly")


def test_comped_store_is_left_to_the_superadmin(client):
    from api.Core.Clock import utc_now
    sid = _seed("pro", "comp", comped_at=utc_now(), comp_reason="beta")
    retrieve = _post(client, live=_live("price_basic_y"))
    assert _store(sid) == ("pro", "comp")
    retrieve.assert_not_called()


@pytest.mark.parametrize("plan", ["trial", "inactive"])
def test_store_not_on_a_paid_plan_is_left_alone(client, plan):
    """Checkout and cancellation own those moves; a late `updated`
    must not hand an inactive store a paid plan."""
    sid = _seed(plan, "")
    retrieve = _post(client, live=_live("price_pro_y"))
    assert _store(sid) == (plan, "")
    retrieve.assert_not_called()


@pytest.mark.parametrize("status", ["canceled", "unpaid", "incomplete",
                                    "incomplete_expired"])
def test_non_billing_status_changes_nothing(client, status):
    sid = _seed("pro", "monthly")
    _post(client, live=_live("price_basic_y", status=status))
    assert _store(sid) == ("pro", "monthly")


def test_stripe_unreachable_changes_nothing(client):
    sid = _seed("pro", "monthly")
    _post(client, live=RuntimeError("stripe down"))
    assert _store(sid) == ("pro", "monthly")


def test_unknown_subscription_is_a_noop(client):
    sid = _seed("pro", "monthly", sub_id="sub_ours")
    retrieve = _post(client, "sub_not_ours", live=_live("price_basic_y"))
    assert _store(sid) == ("pro", "monthly")
    retrieve.assert_not_called()


def test_same_plan_does_not_write(client):
    """No change → no commit (a portal edit of the card, say)."""
    from api.Modules.Billing.Services import webhook as wh
    store = MagicMock(plan="pro", billing_cycle="yearly", comped_at=None)
    db_mock = MagicMock()
    with patch.object(wh, "find_store_by_subscription_id", return_value=store), \
            patch.object(wh, "store_has_paid_plan", return_value=True), \
            patch("stripe.Subscription.retrieve",
                  return_value=_live("price_pro_y")):
        wh.handle_stripe_event(db_mock, {
            "type": "customer.subscription.updated",
            "data": {"object": {"id": "sub_x"}},
        })
    assert db_mock.commit.call_count == 0


# ── Price → plan mapping ───────────────────────────────────────────


@pytest.mark.parametrize("price,expected", [
    ("price_basic_m", ("basic", "monthly")),
    ("price_basic_y", ("basic", "yearly")),
    ("price_pro_m", ("pro", "monthly")),
    ("price_pro_y", ("pro", "yearly")),
    ("price_unknown", None),
    ("", None),
])
def test_known_plan_from_price(price, expected):
    from api.Modules.Billing.Services.webhook import known_plan_from_price
    assert known_plan_from_price(price) == expected


def test_unconfigured_price_ids_never_match_an_empty_price(monkeypatch):
    monkeypatch.setenv("STRIPE_BASIC_YEARLY_PRICE_ID", "")
    from api.Modules.Billing.Services.webhook import known_plan_from_price
    assert known_plan_from_price("") is None


def test_checkout_mapping_keeps_its_pro_fallback():
    """Checkout still grants Pro monthly for a price it can't place —
    a paying customer is never locked out."""
    from api.Modules.Billing.Services.webhook import derive_plan_from_price
    assert derive_plan_from_price("price_unknown") == ("pro", "monthly")
    assert derive_plan_from_price("price_basic_y") == ("basic", "yearly")
