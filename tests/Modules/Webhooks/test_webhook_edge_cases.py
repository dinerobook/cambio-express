"""Webhook edge cases: really-signed Stripe deliveries (no
construct_event patch), unknown events, and Resend payload / signature
shapes that the happy-path tests don't reach."""
import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime

import pytest

from api.Modules.Tenancy.Models import User
from api.Modules.Webhooks.Models import EmailEvent, WebhookEvent
from api.Modules.Webhooks.Services import (
    apply_resend_side_effects, verify_resend_signature,
)
from tests._app import db, db_session

STRIPE_SECRET = "whsec_test_secret"  # conftest default


def _stripe_sign(payload: bytes, secret=STRIPE_SECRET, ts=None):
    ts = ts or int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + payload,
                   hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def _post_signed(client, event, **kw):
    payload = json.dumps(event).encode()
    return client.post(
        "/api/v2/webhooks/stripe", data=payload,
        headers={"Stripe-Signature": _stripe_sign(payload, **kw),
                 "Content-Type": "application/json"},
    )


def test_stripe_really_signed_unknown_event_is_logged_ok(client, monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", STRIPE_SECRET)
    resp = _post_signed(client, {"id": "evt_unknown_1",
                                 "type": "invoice.something_new",
                                 "data": {"object": {}}})
    assert resp.status_code == 200 and resp.get_json() == {"ok": True}
    with db_session():
        row = db.session.query(WebhookEvent).filter_by(
            event_id="evt_unknown_1").one()
        assert row.status == "ok" and row.event_type == "invoice.something_new"


def test_stripe_wrong_secret_signature_rejected_and_logged(client, monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", STRIPE_SECRET)
    resp = _post_signed(client, {"id": "evt_forged", "type": "x"},
                        secret="whsec_attacker")
    assert resp.status_code == 400
    with db_session():
        assert db.session.query(WebhookEvent).filter_by(
            status="signature_err").count() == 1
        assert db.session.query(WebhookEvent).filter_by(
            event_id="evt_forged").count() == 0


def test_stripe_tampered_body_rejected(client, monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", STRIPE_SECRET)
    signed = json.dumps({"id": "evt_a", "type": "x"}).encode()
    header = _stripe_sign(signed)
    resp = client.post(
        "/api/v2/webhooks/stripe",
        data=json.dumps({"id": "evt_a", "type": "customer.subscription.deleted"}).encode(),
        headers={"Stripe-Signature": header, "Content-Type": "application/json"},
    )
    assert resp.status_code == 400


def test_stripe_unconfigured_secret_rejects_everything(client, monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "")
    resp = _post_signed(client, {"id": "evt_nosecret", "type": "x"})
    assert resp.status_code == 400
    with db_session():
        row = db.session.query(WebhookEvent).filter_by(
            status="signature_err").one()
        assert "not configured" in row.error


def test_stripe_non_json_body_with_valid_signature_rejected(client, monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", STRIPE_SECRET)
    payload = b"definitely not json"
    resp = client.post(
        "/api/v2/webhooks/stripe", data=payload,
        headers={"Stripe-Signature": _stripe_sign(payload),
                 "Content-Type": "application/json"},
    )
    assert resp.status_code == 400


# ── Resend ──────────────────────────────────────────────────────

def _resend_secret():
    secret = "whsec_" + base64.b64encode(b"edge-secret").decode()
    os.environ["RESEND_WEBHOOK_SECRET"] = secret
    return base64.b64decode(secret[len("whsec_"):])


def _resend_headers(key, body, ts=None, svix_id="msg_edge"):
    ts = ts or str(int(datetime.utcnow().timestamp()))
    sig = base64.b64encode(hmac.new(
        key, f"{svix_id}.{ts}.".encode() + body, hashlib.sha256).digest()).decode()
    return {"svix-id": svix_id, "svix-timestamp": ts,
            "svix-signature": f"v1,{sig}"}


def _post_resend(client, payload):
    key = _resend_secret()
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return client.post("/api/v2/webhooks/resend", data=body,
                       content_type="application/json",
                       headers=_resend_headers(key, body))


def test_resend_string_recipient_is_normalised_and_stamps_user(client, test_admin_id):
    with db_session():
        db.session.get(User, test_admin_id).email = "Owner@Example.com"
        db.session.commit()
    resp = _post_resend(client, {
        "type": "email.bounced",
        "data": {"email_id": "re_1", "to": "  OWNER@example.com ",
                 "bounce": {"type": "hard"}},
    })
    assert resp.status_code == 200
    with db_session():
        ev = db.session.query(EmailEvent).one()
        assert ev.to_addr == "owner@example.com"
        assert ev.user_id == test_admin_id and ev.bounce_type == "hard"
        assert db.session.get(User, test_admin_id).email_bounced_at is not None


def test_resend_event_without_recipients_stores_nothing(client):
    for payload in ({}, {"type": "email.sent"}, {"type": "email.sent", "data": {"to": []}},
                    {"type": "email.sent", "data": None}):
        assert _post_resend(client, payload).status_code == 200
    with db_session():
        assert db.session.query(EmailEvent).count() == 0


def test_resend_non_dict_bounce_field_is_ignored(client):
    resp = _post_resend(client, {
        "type": "email.bounced",
        "data": {"to": ["x@example.com"], "bounce": "hard"},
    })
    assert resp.status_code == 200
    with db_session():
        assert db.session.query(EmailEvent).one().bounce_type == ""


def test_resend_stale_timestamp_rejected_by_route(client):
    key = _resend_secret()
    body = json.dumps({"type": "email.sent", "data": {"to": ["a@b.com"]}}).encode()
    stale = str(int(datetime.utcnow().timestamp()) - 3600)
    resp = client.post("/api/v2/webhooks/resend", data=body,
                       content_type="application/json",
                       headers=_resend_headers(key, body, ts=stale))
    assert resp.status_code == 400
    with db_session():
        assert db.session.query(EmailEvent).count() == 0


# ── verify_resend_signature / apply_resend_side_effects units ──

@pytest.mark.parametrize("secret,ts,sig", [
    ("whsec_" + base64.b64encode(b"k").decode(), "not-a-number", "v1,abc"),
    ("no-prefix-secret", None, "v1,abc"),
    ("whsec_a", None, "v1,abc"),  # invalid base64 padding
    ("whsec_" + base64.b64encode(b"k").decode(), None, "garbage-no-comma"),
    ("whsec_" + base64.b64encode(b"k").decode(), None, "v2,abc"),
    ("whsec_" + base64.b64encode(b"k").decode(), None, "v1,wrong"),
])
def test_verify_resend_signature_rejects_malformed_inputs(secret, ts, sig):
    ts = ts or str(int(datetime.utcnow().timestamp()))
    assert verify_resend_signature(secret, "id", ts, sig, b"{}") is False


def test_apply_side_effects_ignores_blank_and_unknown_addresses(test_admin_id):
    with db_session():
        apply_resend_side_effects(db.session, "email.complained", "", "")
        apply_resend_side_effects(db.session, "email.complained",
                                  "nobody@nowhere.example", "")
        assert db.session.get(User, test_admin_id).email_bounced_at is None
