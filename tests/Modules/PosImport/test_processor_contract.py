"""DineroBook Processor / Manager (desktop/windows) against the server.

The Windows programs copy parts of the server by hand, in
``desktop/windows/Processor.Core/ServerContract.cs``. These tests read
that file and fail when the two sides drift apart:

  * the limits it mirrors (file size, filename and label length, key
    prefix, the upload and sign-in rate limits);
  * every path it calls is a live route with that method;
  * the answer fields it reads still exist;
  * "Test connection" checks a key with content that is not base64: the
    key is checked first (401) and the content is refused (422, that
    exact sentence) before anything is stored;
  * the Manager ends a sign-in with POST /auth/logout carrying only the
    refresh cookie named by the login answer's ``refresh_jti``.

No server behaviour changes here.
"""
from __future__ import annotations

import re
from pathlib import Path

from tests.Modules.PosImport.test_agent import _admin, _issue_key
from tests.Modules.Auth.test_employee_login import _make_store, _make_user
from tests._app import db_session

ROOT = Path(__file__).resolve().parents[3]
CONTRACT = ROOT / "desktop" / "windows" / "Processor.Core" / "ServerContract.cs"
PREFIX = "/api/v2"


def _clear_cookies() -> None:
    """Drop every cookie the shared test client holds: the Windows app
    keeps none, so nothing may ride along by accident."""
    from tests.conftest import _starlette_client
    _starlette_client.cookies.clear()


def _source() -> str:
    return CONTRACT.read_text(encoding="utf-8")


def _int(name: str) -> int:
    m = re.search(rf"public const int {name} = (\d+);", _source())
    assert m, f"{name} missing from ServerContract.cs"
    return int(m.group(1))


def _str(name: str) -> str:
    m = re.search(rf'public const string {name} = "([^"]*)";', _source())
    assert m, f"{name} missing from ServerContract.cs"
    return m.group(1)


def _limit_on(controller: str, func: str) -> str:
    src = (ROOT / controller).read_text(encoding="utf-8")
    m = re.search(rf'@_rate_limiter\.limit\("([^"]+)"\)\s*\ndef {func}\(', src)
    assert m, f"no rate limit found on {func}"
    return m.group(1)


def test_mirrored_limits_match_the_server():
    from api.Modules.PosImport.Requests import (
        AgentKeyIssueRequest, AgentUploadRequest,
    )
    from api.Modules.PosImport.Services.agent import (
        KEY_PREFIX, MAX_AGENT_FILE_BYTES,
    )
    upload = AgentUploadRequest.model_json_schema()["properties"]
    label = AgentKeyIssueRequest.model_json_schema()["properties"]["label"]
    assert _int("MaxFileBytes") == MAX_AGENT_FILE_BYTES
    assert _int("MaxFilenameLength") == upload["filename"]["maxLength"]
    assert _int("MaxKeyLabelLength") == label["maxLength"]
    assert _str("AgentKeyPrefix") == KEY_PREFIX
    assert set(upload) == {"filename", "content_base64"}


def test_mirrored_rate_limits_match_the_routes():
    upload = _limit_on("api/Modules/PosImport/Controllers/__init__.py", "agent_upload_route")
    assert upload == (
        f"{_int('UploadLimitPerMinute')}/minute;{_int('UploadLimitPerHour')}/hour"
    )
    for route in ("login_route", "login_cross_store_route",
                  "login_totp_route", "login_recovery_route"):
        limit = _limit_on("api/Modules/Auth/Controllers/__init__.py", route)
        assert limit.startswith(f"{_int('SignInLimitPerMinute')}/minute"), route


def test_every_path_the_windows_app_calls_is_a_live_route():
    from fastapi.routing import APIRoute
    from api.main import api_app
    live = {
        (m, r.path) for r in api_app.routes if isinstance(r, APIRoute)
        for m in r.methods or ()
    }
    calls = {
        "UploadPath": "POST", "AgentKeysPath": "POST",
        "LoginCrossStorePath": "POST", "LoginPath": "POST",
        "LoginTotpPath": "POST", "LoginRecoveryPath": "POST",
        "LogoutPath": "POST", "MyStoresPath": "GET",
        "SwitchStorePath": "POST", "SessionStatusPath": "GET",
        "HealthPath": "GET",
    }
    for name, method in calls.items():
        path = _str(name)
        assert path.startswith(PREFIX), name
        assert (method, path[len(PREFIX):]) in live, f"{method} {path}"
    revoke = _str("AgentKeyRevokePathFormat").replace("{0}", "{key_id}")
    assert ("POST", revoke[len(PREFIX):]) in live


def test_answer_fields_the_windows_app_reads_still_exist():
    from api.Modules.Auth.Requests.login import LoginResponse
    from api.Modules.Auth.Requests.session import SessionStatusResponse
    from api.Modules.Auth.Requests.switch_store import (
        SwitchStoreResponse, SwitchableStoreRow,
    )
    from api.Modules.PosImport.Requests import (
        AgentKeyIssueResponse, AgentUploadResponse,
    )
    assert set(AgentUploadResponse.model_fields) == {
        "staged", "duplicate", "business_date", "parse_error",
    }
    assert set(AgentKeyIssueResponse.model_fields) == {"id", "label", "key"}
    assert {
        "access_token", "refresh_jti", "user_id", "username", "full_name",
        "role", "store_id", "permissions", "requires_totp", "pending_token",
        "has_recovery_codes", "enroll_required",
    } <= set(LoginResponse.model_fields)
    assert {"store_id", "name", "address", "is_home"} <= set(SwitchableStoreRow.model_fields)
    assert {"access_token", "store_id", "store_name"} <= set(SwitchStoreResponse.model_fields)
    assert {"store_name", "permissions"} <= set(SessionStatusResponse.model_fields)


def test_the_key_check_is_refused_before_anything_is_stored(client, test_store_id):
    from api.Modules.PosImport.Models import PosJournalFile
    from tests._app import db
    key = _issue_key(client, _admin(client, test_store_id))["key"]
    # The upload must stand on the key alone, not the admin's cookie.
    _clear_cookies()
    probe = {"filename": "dinerobook-processor-connection-test.xml", "content_base64": "!"}

    good = client.post("/api/v2/posimport/agent/upload", headers={"X-Agent-Key": key}, json=probe)
    assert good.status_code == 422, good.text
    assert good.json()["detail"] == _str("NotBase64Detail")

    bad = client.post("/api/v2/posimport/agent/upload",
                      headers={"X-Agent-Key": "pak_not_a_real_key"}, json=probe)
    assert bad.status_code == 401, bad.text

    with db_session():
        assert db.session.query(PosJournalFile).filter_by(
            filename=probe["filename"],
        ).count() == 0


def test_logout_with_only_the_refresh_cookie_ends_the_sign_in(client):
    with db_session():
        sid = _make_store("proc-contract", "Processor Contract")
        _make_user(sid, "proc-admin", "procpw1234!", role="admin")
    login = client.post("/api/v2/auth/login-cross-store",
                        json={"username": "proc-admin", "password": "procpw1234!"})
    assert login.status_code == 200, login.text
    body = login.json()
    assert body["refresh_jti"]
    token = body["access_token"]
    # The Manager keeps no cookies: it sends the token as a header...
    _clear_cookies()
    assert client.get("/api/v2/auth/session-status",
                      headers={"Authorization": f"Bearer {token}"}).status_code == 200
    # ...and signs out with the refresh_jti as the one cookie.
    out = client.post(
        "/api/v2/auth/logout",
        headers={"Cookie": f"{_str('RefreshCookieName')}={body['refresh_jti']}"},
    )
    assert out.status_code == 204
    _clear_cookies()
    after = client.get("/api/v2/auth/session-status",
                       headers={"Authorization": f"Bearer {token}"})
    assert after.status_code == 401
