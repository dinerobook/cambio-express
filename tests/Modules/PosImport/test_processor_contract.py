"""DineroBook Processor / Manager (desktop/windows) against the server.

The Windows programs copy parts of the server by hand, in
``desktop/windows/Processor.Core/ServerContract.cs``. These tests read
that file and fail when the two sides drift apart:

  * the limits it mirrors (file size, filename and label length, key
    prefix, connect-code length, the upload and connect rate limits);
  * every path it calls is a live route with that method;
  * its business-day reader knows the journal event kinds, in the
    server's order (``BusinessDateReader.cs``);
  * the answer fields it reads still exist;
  * "Test connection" checks a key with content that is not base64: the
    key is checked first (401) and the content is refused (422, that
    exact sentence) before anything is stored.

The Manager connects with a one-time connect code
(``POST /posimport/agent/pair``), never a name or a password; the
route itself is tested in ``test_agent_pairing.py``.
"""
from __future__ import annotations

import re
from pathlib import Path

from tests.Modules.PosImport.test_agent import _admin, _issue_key
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


def _int(name: str, source: str | None = None) -> int:
    m = re.search(rf"public const int {name} = (\d+);", source or _source())
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
        AgentKeyIssueRequest, AgentPairRequest, AgentUploadRequest,
    )
    from api.Modules.PosImport.Services.agent import (
        KEY_PREFIX, MAX_AGENT_FILE_BYTES,
    )
    from api.Modules.PosImport.Services.pairing import PAIRING_LENGTH
    upload = AgentUploadRequest.model_json_schema()["properties"]
    pair = AgentPairRequest.model_json_schema()["properties"]
    label = AgentKeyIssueRequest.model_json_schema()["properties"]["label"]
    assert _int("MaxFileBytes") == MAX_AGENT_FILE_BYTES
    assert _int("MaxFilenameLength") == upload["filename"]["maxLength"]
    assert _int("MaxKeyLabelLength") == pair["label"]["maxLength"] == label["maxLength"]
    assert _str("AgentKeyPrefix") == KEY_PREFIX
    assert set(upload) == {"filename", "content_base64"}
    assert set(pair) == {"code", "label"}
    connect = (CONTRACT.parent / "Connect" / "ConnectClient.cs").read_text(encoding="utf-8")
    assert _int("Length", connect) == PAIRING_LENGTH


def test_the_business_day_reader_knows_the_servers_event_kinds_in_order():
    """The Processor keeps a business day's files ahead of the next day's,
    reading each file's day as parse_pjr does: the first event kind found
    in this order. A kind the server learns but the reader does not would
    make those files "undated" there, sent with no day barrier."""
    from api.Modules.PosImport.Services.naxml import _EVENT_KINDS
    src = (CONTRACT.parent / "BusinessDateReader.cs").read_text(encoding="utf-8")
    m = re.search(r"EventKinds = \[([^\]]+)\];", src)
    assert m, "EventKinds missing from BusinessDateReader.cs"
    kinds = re.findall(r'"([A-Za-z]+)"', m.group(1))
    assert kinds == list(_EVENT_KINDS)


def test_mirrored_rate_limits_match_the_routes():
    upload = _limit_on("api/Modules/PosImport/Controllers/__init__.py", "agent_upload_route")
    assert upload == (
        f"{_int('UploadLimitPerMinute')}/minute;{_int('UploadLimitPerHour')}/hour"
    )
    pair = _limit_on("api/Modules/PosImport/Controllers/__init__.py", "agent_pair_route")
    assert pair.startswith(f"{_int('PairLimitPerMinute')}/minute")


def test_every_path_the_windows_app_calls_is_a_live_route():
    from fastapi.routing import APIRoute
    from api.main import api_app
    live = {
        (m, r.path) for r in api_app.routes if isinstance(r, APIRoute)
        for m in r.methods or ()
    }
    calls = {"UploadPath": "POST", "PairPath": "POST", "HealthPath": "GET"}
    for name, method in calls.items():
        path = _str(name)
        assert path.startswith(PREFIX), name
        assert (method, path[len(PREFIX):]) in live, f"{method} {path}"


def test_answer_fields_the_windows_app_reads_still_exist():
    from api.Modules.PosImport.Requests import (
        AgentPairResponse, AgentUploadResponse,
    )
    assert set(AgentUploadResponse.model_fields) == {
        "staged", "duplicate", "business_date", "parse_error",
    }
    assert set(AgentPairResponse.model_fields) == {
        "id", "label", "key", "store_id", "store_name", "connected_by",
    }


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
