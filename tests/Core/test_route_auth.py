"""Every API route needs a signed-in caller unless it is on the
public list below — checked by walking the live router, so a new
route that forgets ``Depends(get_principal)`` fails here before it
ships (2026-10-21 sweep). The per-role gates are covered by the
superadmin contract test, the store isolation walk and each
module's own grant/deny tests; this one is the floor under them.

A route belongs on ``PUBLIC`` only when a person who is not signed
in must reach it: signing in and its recovery steps, sign-up, the
public price list, liveness, and the provider webhooks (which check
a signature instead).
"""
from __future__ import annotations

import re

import pytest
from fastapi.routing import APIRoute

PUBLIC: dict[str, set[str]] = {
    "/health": {"GET"},
    "/maintenance-status": {"GET"},
    "/billing/pricing": {"GET"},
    "/auth/login": {"POST"},
    "/auth/login-cross-store": {"POST"},
    "/auth/login/totp": {"POST"},
    "/auth/login/recovery": {"POST"},
    "/auth/login/totp/enroll/start": {"POST"},
    "/auth/login/totp/enroll/finish": {"POST"},
    "/auth/login/totp/enroll/confirm": {"POST"},
    "/auth/logout": {"POST"},
    "/auth/refresh": {"POST"},
    "/auth/signup": {"POST"},
    "/auth/signup/owner": {"POST"},
    "/auth/forgot-password": {"POST"},
    "/auth/reset-password": {"POST"},
    "/auth/referral/{code}": {"GET"},
    "/auth/store-by-slug/{slug}": {"GET"},
    "/webhooks/stripe": {"POST"},
    "/webhooks/resend": {"POST"},
}

# Signed in by something other than a person's session: the POS
# site agent sends its own key. Its body is checked before the key,
# so it gets its own test with a well-formed body below.
OWN_KEY = {"/posimport/agent/upload": {"POST"}}


def _routes():
    from api.main import api_app
    out = []
    for r in api_app.routes:
        if isinstance(r, APIRoute):
            for m in sorted(r.methods or ()):
                if m != "HEAD":
                    out.append((m, r.path))
    return out


def _concrete(path: str) -> str:
    def sub(match):
        name = match.group(1)
        return "1" if name.endswith("_id") or name in ("id", "year", "month") else "x"
    return re.sub(r"\{(\w+)(?::[^}]*)?\}", sub, path)


ROUTES = _routes()


def test_walk_finds_the_whole_api():
    assert len(ROUTES) > 300


def test_public_list_names_only_real_routes():
    real = {(m, p) for m, p in ROUTES}
    stale = [(m, p) for p, ms in PUBLIC.items() for m in ms if (m, p) not in real]
    assert stale == []


@pytest.mark.parametrize(
    "method,path",
    [(m, p) for m, p in ROUTES
     if m not in PUBLIC.get(p, set()) | OWN_KEY.get(p, set())],
)
def test_anonymous_caller_is_refused(client, method, path):
    prefix = "" if path.startswith("/webhooks") else "/api/v2"
    resp = client._request(method, prefix + _concrete(path), json={})
    assert resp.status_code == 401, (method, path, resp.status_code)


def test_pos_agent_upload_needs_its_key(client):
    body = {"filename": "a.xml", "content_base64": "eA=="}
    assert client.post("/api/v2/posimport/agent/upload", json=body).status_code == 401
    assert client.post(
        "/api/v2/posimport/agent/upload", json=body,
        headers={"X-Agent-Key": "pak_not-a-real-key"},
    ).status_code == 401
