"""Remember this browser on the 2FA step (owner, 2026-11-21).

Signing out and in again asked the superadmin for the 2FA code every
time. Ticking "Remember this browser for 30 days" now lets THAT browser
skip the code at the next sign-ins, after the password:

* the password is always asked — a remembered browser never gets in
  without it;
* only the browser holding the cookie, only for the person it was
  remembered for;
* 30 days from the code; a password change or a 2FA reset forgets it;
* signing out does not forget it;
* an unenrolled person still enrols;
* the DB keeps only the sha256 of the browser's secret;
* the migration matches the model and imports no application code.
"""

import hashlib
import importlib.util
from datetime import timedelta
from pathlib import Path

import pyotp

from api.Core.Clock import utc_now
from tests._app import db, db_session

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "alembic" / "versions" / "f3b8c1d9e4a7_add_auth_trusted_browser.py"
COOKIE = "db_trusted_browser"
PASSWORD = "super2025!"


def _superadmin(slug: str, *, enrolled: bool = True) -> tuple[str, str]:
    """A fresh superadmin (never the seeded one). Returns (username, secret)."""
    from api.Modules.Tenancy.Models import User
    secret = pyotp.random_base32()
    user = User(
        store_id=None, username=f"{slug}@superadmin", full_name="Test Super",
        role="superadmin",
        totp_secret=secret if enrolled else None,
        totp_enrolled_at=utc_now() if enrolled else None,
    )
    user.set_password(PASSWORD)
    db.session.add(user)
    db.session.commit()
    return user.username, secret


def _password(client, username: str, password: str = PASSWORD, *, cross_store: bool = False):
    if cross_store:
        return client.post("/api/v2/auth/login-cross-store",
                           json={"username": username, "password": password})
    return client.post("/api/v2/auth/login",
                       json={"username": username, "password": password, "store_id": None})


def _sign_in_with_code(client, username: str, secret: str, *, remember: bool):
    pending = _password(client, username).get_json()
    assert pending["requires_totp"] is True
    return client.post("/api/v2/auth/login/totp", json={
        "pending_token": pending["pending_token"],
        "code": pyotp.TOTP(secret).now(),
        "remember_browser": remember,
    })


def _cookie_header(resp) -> str:
    found = [c for c in resp.headers.get_list("set-cookie") if c.startswith(COOKIE + "=")]
    return found[0] if found else ""


def _sign_out_keeping_the_browser():
    """What /auth/logout leaves behind: no session, the remembered
    browser cookie still there."""
    from tests.conftest import _starlette_client
    jar = _starlette_client.cookies
    kept = jar.get(COOKIE)
    jar.clear()
    if kept:
        jar.set(COOKIE, kept, path="/api/v2/auth")


def _rows(username: str):
    from api.Modules.Auth.Models import TrustedBrowser
    from api.Modules.Tenancy.Models import User
    user = db.session.query(User).filter_by(username=username).first()
    return db.session.query(TrustedBrowser).filter_by(user_id=user.id).all()


# ── Remembering ─────────────────────────────────────────────


def test_ticking_the_box_remembers_this_browser_in_a_strict_httponly_cookie(client):
    with db_session():
        username, secret = _superadmin("rb1")
    resp = _sign_in_with_code(client, username, secret, remember=True)

    assert resp.status_code == 200
    assert resp.get_json()["access_token"]
    cookie = _cookie_header(resp)
    assert cookie, resp.headers.get_list("set-cookie")
    assert "HttpOnly" in cookie
    assert "Path=/api/v2/auth" in cookie
    assert "samesite=strict" in cookie.lower()
    assert "Max-Age=2592000" in cookie  # 30 days
    raw = cookie.split(";", 1)[0].split("=", 1)[1]
    with db_session():
        rows = _rows(username)
        assert len(rows) == 1
        # Only the hash is stored, never the secret itself.
        assert rows[0].secret_hash == hashlib.sha256(raw.encode()).hexdigest()
        assert raw not in rows[0].secret_hash
        assert rows[0].expires_at - rows[0].created_at == timedelta(days=30)


def test_without_the_box_nothing_is_remembered(client):
    with db_session():
        username, secret = _superadmin("rb2")
    resp = _sign_in_with_code(client, username, secret, remember=False)

    assert resp.status_code == 200
    assert _cookie_header(resp) == ""
    with db_session():
        assert _rows(username) == []


def test_a_recovery_code_can_remember_the_browser_too(client):
    from api.Modules.Auth.Models import RecoveryCode
    from api.Modules.Auth.Services.totp import hash_recovery_code
    from api.Modules.Tenancy.Models import User
    with db_session():
        username, _ = _superadmin("rb3")
        user = db.session.query(User).filter_by(username=username).first()
        db.session.add(RecoveryCode(user_id=user.id, code_hash=hash_recovery_code("ABCD1234")))
        db.session.commit()
    pending = _password(client, username).get_json()
    resp = client.post("/api/v2/auth/login/recovery", json={
        "pending_token": pending["pending_token"], "code": "ABCD-1234",
        "remember_browser": True,
    })

    assert resp.status_code == 200
    assert _cookie_header(resp)


# ── Signing in again on a remembered browser ────────────────


def test_after_signing_out_the_remembered_browser_skips_the_code(client):
    with db_session():
        username, secret = _superadmin("rb4")
    assert _sign_in_with_code(client, username, secret, remember=True).status_code == 200
    _sign_out_keeping_the_browser()

    again = _password(client, username)

    body = again.get_json()
    assert again.status_code == 200
    assert body["requires_totp"] is False
    assert body["access_token"]
    assert any(c.startswith("db_access_token=") for c in again.headers.get_list("set-cookie"))
    with db_session():
        assert _rows(username)[0].last_used_at is not None


def test_the_cross_store_sign_in_skips_the_code_too(client):
    with db_session():
        username, secret = _superadmin("rb5")
    _sign_in_with_code(client, username, secret, remember=True)
    _sign_out_keeping_the_browser()

    again = _password(client, username, cross_store=True)

    assert again.status_code == 200
    assert again.get_json()["access_token"]


def test_a_remembered_browser_still_needs_the_password(client):
    with db_session():
        username, secret = _superadmin("rb6")
    _sign_in_with_code(client, username, secret, remember=True)
    _sign_out_keeping_the_browser()

    wrong = _password(client, username, "not-the-password")

    assert wrong.status_code == 401
    assert "access_token" not in (wrong.get_json() or {}) or not wrong.get_json().get("access_token")


def test_another_persons_remembered_browser_does_not_skip_the_code(client):
    with db_session():
        first, secret = _superadmin("rb7a")
        second, _ = _superadmin("rb7b")
    _sign_in_with_code(client, first, secret, remember=True)
    _sign_out_keeping_the_browser()

    other = _password(client, second).get_json()

    assert other["requires_totp"] is True
    assert other["access_token"] == ""


def test_a_made_up_cookie_does_not_skip_the_code(client):
    from tests.conftest import _starlette_client
    with db_session():
        username, _ = _superadmin("rb8")
    _starlette_client.cookies.set(COOKIE, "made-up-secret", path="/api/v2/auth")

    assert _password(client, username).get_json()["requires_totp"] is True


def test_after_30_days_the_code_is_asked_again(client):
    with db_session():
        username, secret = _superadmin("rb9")
    _sign_in_with_code(client, username, secret, remember=True)
    _sign_out_keeping_the_browser()
    with db_session():
        row = _rows(username)[0]
        row.expires_at = utc_now() - timedelta(seconds=1)
        db.session.commit()

    assert _password(client, username).get_json()["requires_totp"] is True
    with db_session():
        assert _rows(username) == []  # the stale row is gone


def test_a_password_change_forgets_every_remembered_browser(client):
    from api.Modules.Tenancy.Models import User
    with db_session():
        username, secret = _superadmin("rb10")
    _sign_in_with_code(client, username, secret, remember=True)
    _sign_out_keeping_the_browser()
    with db_session():
        user = db.session.query(User).filter_by(username=username).first()
        user.set_password("a-new-password-2026!")
        db.session.commit()

    again = _password(client, username, "a-new-password-2026!").get_json()

    assert again["requires_totp"] is True


def test_a_2fa_reset_forgets_every_remembered_browser(client):
    from api.Modules.Tenancy.Models import User
    with db_session():
        username, secret = _superadmin("rb11")
    _sign_in_with_code(client, username, secret, remember=True)
    _sign_out_keeping_the_browser()
    with db_session():
        user = db.session.query(User).filter_by(username=username).first()
        user.totp_secret = pyotp.random_base32()  # re-enrolled on a new phone
        user.totp_enrolled_at = utc_now()
        db.session.commit()

    assert _password(client, username).get_json()["requires_totp"] is True


def test_someone_who_must_enrol_still_enrols(client):
    from api.Modules.Auth.Services.remembered_browser import remember
    from api.Modules.Tenancy.Models import User
    from tests.conftest import _starlette_client
    with db_session():
        username, _ = _superadmin("rb12", enrolled=False)
        user = db.session.query(User).filter_by(username=username).first()
        raw = remember(db.session, user, user_agent="test")
        db.session.commit()
    _starlette_client.cookies.set(COOKIE, raw, path="/api/v2/auth")

    body = _password(client, username).get_json()

    assert body["requires_totp"] is True
    assert body["enroll_required"] is True


# ── The migration ───────────────────────────────────────────


def _migration():
    spec = importlib.util.spec_from_file_location(MIGRATION.stem, MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_imports_no_application_code():
    for line in MIGRATION.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped


def test_migration_matches_the_model():
    from api.Modules.Auth.Models import TrustedBrowser
    m = _migration()
    table = TrustedBrowser.__table__
    assert table.name == m.TABLE
    migration_cols = {c.name: c for c in m._columns()}
    assert list(migration_cols) == [c.name for c in table.columns]
    for col in table.columns:
        other = migration_cols[col.name]
        assert type(other.type) is type(col.type), col.name
        assert other.nullable == col.nullable, col.name
        if hasattr(col.type, "length"):
            assert other.type.length == col.type.length, col.name
