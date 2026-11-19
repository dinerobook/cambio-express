"""The site agent script (``agent/dinerobook_agent.py``) backs off
when the server refuses the store.

A disabled store answers 403 and a frozen or lapsed one 402
(``test_agent_store_gates.py``). Neither is fixed by a quick retry,
so the agent waits ``REFUSED_WAIT_SECONDS`` once and leaves the file
unsent (it goes up when the store is open again), instead of walking
the whole retry ladder for every file. 401 keeps that behaviour and
422 still skips the file for good.
"""
import importlib.util
import io
import urllib.error
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[3] / "agent" / "dinerobook_agent.py"


@pytest.fixture
def agent():
    spec = importlib.util.spec_from_file_location("dinerobook_agent", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_upload(agent, monkeypatch, tmp_path, code, body=b"{}"):
    calls, sleeps = [], []

    def fake_urlopen(request, timeout):
        calls.append(request.full_url)
        raise urllib.error.HTTPError(
            request.full_url, code, "refused", {}, io.BytesIO(body),
        )

    monkeypatch.setattr(agent.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(agent.time, "sleep", sleeps.append)
    path = tmp_path / "PJR1.xml"
    path.write_bytes(b"<xml/>")
    cfg = {"api_url": "https://example.test", "agent_key": "pak_x"}
    return agent.upload(cfg, path), calls, sleeps


@pytest.mark.parametrize("code", [402, 403])
def test_refused_store_waits_once_and_keeps_the_file(
    agent, monkeypatch, tmp_path, caplog, code,
):
    body = b'{"detail": "This store has been disabled. Contact support."}'
    accepted, calls, sleeps = _run_upload(
        agent, monkeypatch, tmp_path, code, body,
    )
    assert accepted is False          # not in the ledger: sent later
    assert len(calls) == 1            # no retry ladder
    assert sleeps == [agent.REFUSED_WAIT_SECONDS]
    assert "This store has been disabled" in caplog.text


def test_rejected_key_still_waits(agent, monkeypatch, tmp_path):
    accepted, calls, sleeps = _run_upload(agent, monkeypatch, tmp_path, 401)
    assert accepted is False
    assert len(calls) == 1
    assert sleeps == [agent.REFUSED_WAIT_SECONDS]


def test_rejected_file_is_skipped_for_good(agent, monkeypatch, tmp_path):
    accepted, calls, sleeps = _run_upload(agent, monkeypatch, tmp_path, 422)
    assert accepted is True
    assert len(calls) == 1
    assert sleeps == []
