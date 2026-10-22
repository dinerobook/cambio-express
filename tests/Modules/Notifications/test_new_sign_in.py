"""New sign-in alert — a device this account has not used before.

Service level (``Notifications.Services.new_sign_in``): the device
label, off until switched on (owner's choice), the "new device" rule.
Route level: signing in from a second device emails + pushes, the same
device again does not, a broken sender never breaks sign-in, the
notifications page round-trips the two toggles, and the address
recorded is the one Render's proxy appended (a client cannot write
its own into the Devices page or the alert).
"""
import os
import pathlib

import pytest

from tests._app import db, db_session


CHROME_WIN = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)
CHROME_WIN_NEXT = CHROME_WIN.replace("Chrome/130", "Chrome/131")
SAFARI_IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 "
    "Mobile/15E148 Safari/604.1"
)
EDGE_MAC = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
)


# ── Fixtures ─────────────────────────────────────────────────


@pytest.fixture
def outbox(monkeypatch):
    """Capture send_email + send_push from the worker."""
    emails: list[dict] = []
    pushes: list[dict] = []
    from api.Modules.Notifications.Services import push as push_mod
    from api.Modules.Notifications.Services import smtp as smtp_mod
    monkeypatch.setattr(
        smtp_mod, "send_email",
        lambda db_, to, subject, body, html=None: emails.append(
            {"to": to, "subject": subject, "body": body, "html": html},
        ) or True,
    )
    monkeypatch.setattr(
        push_mod, "send_push",
        lambda db_, user_id, title, body="", url="/", tag=None: pushes.append(
            {"user_id": user_id, "title": title, "body": body, "url": url},
        ) or 1,
    )
    return {"emails": emails, "pushes": pushes}


ON = {"notify_new_sign_in": True, "notify_new_sign_in_push": True}


def _make_user(store_id, role="admin", **prefs):
    """A fresh login with no sign-in history, so 'first sign-in' and
    'new device' are decided by this test alone."""
    from api.Modules.Tenancy.Models import User
    with db_session():
        tag = os.urandom(3).hex()
        u = User(
            store_id=store_id, username=f"signin_{role}_{tag}",
            full_name="Alert Person", role=role, is_active=True,
            email=f"signin_{tag}@example.com",
        )
        u.set_password("testpass123!")
        for k, v in prefs.items():
            setattr(u, k, v)
        db.session.add(u)
        db.session.commit()
        return u.id, u.username, u.email


def _sign_in(client, username, store_id, ua, xff="203.0.113.7"):
    resp = client.post(
        "/api/v2/auth/login",
        json={"username": username, "password": "testpass123!",
              "store_id": store_id},
        headers={"User-Agent": ua, "X-Forwarded-For": xff},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()


# ── Device label ─────────────────────────────────────────────


@pytest.mark.parametrize("ua,label", [
    (CHROME_WIN, "Chrome on Windows"),
    (SAFARI_IPHONE, "Safari on iPhone"),
    (EDGE_MAC, "Edge on macOS"),
    ("curl/8.4.0", "curl"),
    ("", "Unknown device"),
    (None, "Unknown device"),
])
def test_describe_user_agent(ua, label):
    from api.Modules.Notifications.Services.new_sign_in import (
        describe_user_agent,
    )
    assert describe_user_agent(ua) == label


# ── Preference: off until the person switches it on ──────────


class _U:
    def __init__(self, role, email=None, push=None):
        self.role = role
        self.notify_new_sign_in = email
        self.notify_new_sign_in_push = push


@pytest.mark.parametrize("role", [
    "admin", "owner", "superadmin", "employee", "support", "",
])
def test_never_chosen_is_off_for_every_role(role):
    from api.Modules.Notifications.Services.new_sign_in import (
        wants_new_sign_in,
    )
    assert wants_new_sign_in(_U(role), "email") is False
    assert wants_new_sign_in(_U(role), "push") is False


def test_each_channel_follows_its_own_switch():
    from api.Modules.Notifications.Services.new_sign_in import (
        wants_new_sign_in,
    )
    assert wants_new_sign_in(_U("admin", email=True), "email") is True
    assert wants_new_sign_in(_U("admin", email=True), "push") is False
    assert wants_new_sign_in(_U("employee", push=True), "push") is True
    assert wants_new_sign_in(_U("employee", push=True), "email") is False


# ── Sign-in → alert ──────────────────────────────────────────


def test_first_sign_in_and_same_device_stay_quiet(client, test_store_id, outbox):
    _, username, _ = _make_user(test_store_id, **ON)
    _sign_in(client, username, test_store_id, CHROME_WIN)
    _sign_in(client, username, test_store_id, CHROME_WIN)
    # A browser update is the same device, not a new one.
    _sign_in(client, username, test_store_id, CHROME_WIN_NEXT)
    assert outbox["emails"] == []
    assert outbox["pushes"] == []


def test_new_device_emails_and_pushes_when_switched_on(
    client, test_store_id, outbox,
):
    uid, username, email = _make_user(test_store_id, **ON)
    _sign_in(client, username, test_store_id, CHROME_WIN)
    _sign_in(client, username, test_store_id, SAFARI_IPHONE,
             xff="10.0.0.1, 198.51.100.23")

    assert len(outbox["emails"]) == 1
    sent = outbox["emails"][0]
    assert sent["to"] == email
    assert sent["subject"] == "New sign-in to your DineroBook account"
    assert "Safari on iPhone" in sent["body"]
    # The address Render's proxy appended, not the client-written one.
    assert "198.51.100.23" in sent["body"]
    assert "10.0.0.1" not in sent["body"]
    assert "/app/account/sessions" in sent["body"]
    assert sent["html"] and "Safari on iPhone" in sent["html"]

    assert outbox["pushes"] == [{
        "user_id": uid, "title": "New sign-in to your account",
        "body": "Safari on iPhone · 198.51.100.23. Not you? Sign it out.",
        "url": "/app/account/sessions",
    }]


@pytest.mark.parametrize("role", ["admin", "employee"])
def test_never_switched_on_stays_quiet(client, test_store_id, outbox, role):
    """Owner's choice 2026-10-22: off for everyone, Admins included,
    until the person switches it on."""
    _, username, _ = _make_user(test_store_id, role=role)
    _sign_in(client, username, test_store_id, CHROME_WIN)
    _sign_in(client, username, test_store_id, SAFARI_IPHONE)
    assert outbox["emails"] == [] and outbox["pushes"] == []


def test_employee_who_switched_email_on_gets_email_only(
    client, test_store_id, outbox,
):
    _, username, _ = _make_user(
        test_store_id, role="employee", notify_new_sign_in=True,
    )
    _sign_in(client, username, test_store_id, CHROME_WIN)
    _sign_in(client, username, test_store_id, SAFARI_IPHONE)
    assert len(outbox["emails"]) == 1
    assert outbox["pushes"] == []


def test_admin_who_turned_it_off_gets_nothing(client, test_store_id, outbox):
    _, username, _ = _make_user(
        test_store_id, notify_new_sign_in=False, notify_new_sign_in_push=False,
    )
    _sign_in(client, username, test_store_id, CHROME_WIN)
    _sign_in(client, username, test_store_id, SAFARI_IPHONE)
    assert outbox["emails"] == [] and outbox["pushes"] == []


def test_bounced_address_skips_email_but_still_pushes(
    client, test_store_id, outbox,
):
    from api.Core.Clock import utc_now
    _, username, _ = _make_user(
        test_store_id, email_bounced_at=utc_now(), **ON,
    )
    _sign_in(client, username, test_store_id, CHROME_WIN)
    _sign_in(client, username, test_store_id, SAFARI_IPHONE)
    assert outbox["emails"] == []
    assert len(outbox["pushes"]) == 1


def test_a_broken_sender_never_breaks_sign_in(client, test_store_id, monkeypatch):
    from api.Modules.Notifications.Services import new_sign_in

    def boom(*_a, **_k):
        raise RuntimeError("smtp down")
    monkeypatch.setattr(new_sign_in, "send_new_sign_in_alert", boom)
    _, username, _ = _make_user(test_store_id, **ON)
    _sign_in(client, username, test_store_id, CHROME_WIN)
    body = _sign_in(client, username, test_store_id, SAFARI_IPHONE)
    assert body["access_token"]


def test_worker_ignores_inactive_or_missing_users(test_store_id, outbox):
    from api.Modules.Notifications.Services.new_sign_in import (
        send_new_sign_in_alert,
    )
    from api.Modules.Tenancy.Models import User
    uid, _, _ = _make_user(test_store_id, **ON)
    with db_session():
        db.session.get(User, uid).is_active = False
        db.session.commit()
    assert send_new_sign_in_alert(uid, "nope") == 0
    assert send_new_sign_in_alert(999_999, "nope") == 0
    assert outbox["emails"] == []


# ── Devices page address ─────────────────────────────────────


def test_devices_page_shows_the_proxy_address(client, test_store_id):
    _, username, _ = _make_user(test_store_id)
    token = _sign_in(
        client, username, test_store_id, CHROME_WIN,
        xff="6.6.6.6, 198.51.100.40",
    )["access_token"]
    rows = client.get(
        "/api/v2/auth/sessions",
        headers={"Authorization": f"Bearer {token}"},
    ).get_json()["sessions"]
    assert [r["ip_address"] for r in rows] == ["198.51.100.40"]


# ── Notifications page ───────────────────────────────────────


def _token(client, username, store_id):
    return _sign_in(client, username, store_id, CHROME_WIN)["access_token"]


def test_notifications_show_off_until_switched_on(client, test_store_id):
    for role in ("admin", "employee"):
        _, username, _ = _make_user(test_store_id, role=role)
        h = {"Authorization": f"Bearer {_token(client, username, test_store_id)}"}
        body = client.get("/api/v2/auth/notifications", headers=h).get_json()
        assert body["notify_new_sign_in"] is False
        assert body["notify_new_sign_in_push"] is False


def test_notifications_round_trip(client, test_store_id):
    from api.Modules.Tenancy.Models import User
    uid, username, _ = _make_user(test_store_id)
    h = {"Authorization": f"Bearer {_token(client, username, test_store_id)}"}
    resp = client.put(
        "/api/v2/auth/notifications", headers=h,
        json={"notify_new_sign_in": True},
    )
    assert resp.status_code == 200
    assert resp.get_json()["notify_new_sign_in"] is True
    # The untouched channel stays off.
    assert resp.get_json()["notify_new_sign_in_push"] is False
    with db_session():
        u = db.session.get(User, uid)
        assert u.notify_new_sign_in is True
        assert u.notify_new_sign_in_push is None


def test_notifications_need_a_sign_in(client):
    assert client.get("/api/v2/auth/notifications").status_code == 401
    assert client.put(
        "/api/v2/auth/notifications", json={"notify_new_sign_in": True},
    ).status_code == 401


def test_notifications_refuse_a_non_boolean(client, test_store_id):
    _, username, _ = _make_user(test_store_id)
    h = {"Authorization": f"Bearer {_token(client, username, test_store_id)}"}
    resp = client.put(
        "/api/v2/auth/notifications", headers=h,
        json={"notify_new_sign_in": "sometimes"},
    )
    assert resp.status_code == 422


# ── Migration ────────────────────────────────────────────────


_MIGRATION = (
    pathlib.Path(__file__).resolve().parents[3]
    / "alembic" / "versions" / "b8e4f2a6c1d3_new_sign_in_alert.py"
)


def test_migration_matches_model_and_imports_no_app_code():
    import importlib.util
    from api.Modules.Tenancy.Models import User
    src = _MIGRATION.read_text()
    assert "from api" not in src and "import api" not in src
    spec = importlib.util.spec_from_file_location("_mig", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for name in mod.COLUMNS:
        col = User.__table__.c[name]
        assert col.nullable is True
        assert col.type.python_type is bool
