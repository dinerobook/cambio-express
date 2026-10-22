"""Rate limiter regression tests.

Validates the slowapi wiring in api/main.py + api/Core/RateLimit.
The conftest globally disables rate limiting via
`RATELIMIT_ENABLED=0` so every other test in the suite doesn't get
429'd; we exercise the 429 path in a subprocess with the env var
set fresh.

Tuning notes — if you bump the limits on the auth controller, update
the expected counts here too.
"""
from __future__ import annotations

import os
import subprocess
import sys

import pytest


def test_slowapi_limiter_disabled_in_test_env():
    """The conftest forces RATELIMIT_ENABLED=0. The slowapi limiter
    must pick that up at import time. Regression guard for the
    `os.environ["RATELIMIT_ENABLED"] = "0"` line in conftest.py
    and the explicit `limiter.enabled = _enabled` override in
    api/Core/RateLimit.py (slowapi otherwise stores the env-var
    string instead of a bool)."""
    from api.Core.RateLimit import limiter as slow_limiter

    assert slow_limiter.enabled is False


# ── Subprocess-based assertions ───────────────────────────────
#
# slowapi decides whether to enforce limits at import time. To
# exercise the 429 path we spawn a fresh subprocess with
# RATELIMIT_ENABLED=1 set in the env before `import app` runs.

def _run_in_subprocess(script: str) -> tuple[int, str, str]:
    """Run `script` in a fresh Python process with the limiter on."""
    env = {
        **os.environ,
        "RATELIMIT_ENABLED": "1",
        "DATABASE_URL": "sqlite:///:memory:",
        "SECRET_KEY": "test-secret-key-for-ci",
        "STRIPE_SECRET_KEY": "sk_test_fake_key",
        "STRIPE_BASIC_PRICE_ID": "price_basic_test",
        "STRIPE_PRO_PRICE_ID": "price_pro_test",
        "STRIPE_WEBHOOK_SECRET": "whsec_test_secret",
        "SPA_CUTOVER_ENABLED": "0",
    }
    res = subprocess.run(
        [sys.executable, "-c", script],
        env=env, capture_output=True, text=True, timeout=60,
    )
    return res.returncode, res.stdout, res.stderr


def test_fastapi_login_429_with_limiter_enabled_at_boot():
    """slowapi: 429 within a small burst when the limiter is
    enabled at boot. The subprocess hits the production
    ``asgi_app`` directly via Starlette's ``TestClient`` — same
    transport tests use everywhere else."""
    script = (
        "from starlette.testclient import TestClient\n"
        "from asgi import asgi_app\n"
        "with TestClient(asgi_app) as c:\n"
        "    statuses = []\n"
        "    for _ in range(15):\n"
        "        r = c.post('/api/v2/auth/login',\n"
        "            json={'username':'nope','password':'wrong','store_id':0})\n"
        "        statuses.append(r.status_code)\n"
        "        if r.status_code == 429:\n"
        "            break\n"
        "assert 429 in statuses, f'never saw 429: {statuses}'\n"
        "print('OK')\n"
    )
    rc, out, err = _run_in_subprocess(script)
    assert rc == 0, f"stderr:\n{err}\nstdout:\n{out}"
    assert "OK" in out


# ── Limited routes must not 500 after they run ───────────────
#
# slowapi with ``headers_enabled=True`` stamps X-RateLimit-* onto the
# route's return value AFTER the route ran, and raises when that value
# is a Pydantic model or dict and the route takes no
# ``response: Response``. The route had already committed, so the
# caller saw a 500 for a write that landed (live 2026-10-13: one New
# Transfer saved 8 times). The suite runs with the limiter OFF, so
# these arm it in-process: slowapi reads ``enabled`` on every call.


def test_rate_limit_headers_stay_off():
    from api.Core.RateLimit import limiter as slow_limiter
    assert slow_limiter._headers_enabled is False


def _armed():
    from api.Core.RateLimit import limiter as slow_limiter
    slow_limiter.reset()
    slow_limiter.enabled = True
    return slow_limiter


def _disarm(slow_limiter):
    slow_limiter.enabled = False
    slow_limiter.reset()


def test_limited_route_returning_a_dict_answers_200_with_limiter_on(client):
    """``/auth/forgot-password`` returns a plain dict and takes no
    ``response`` parameter, the exact shape that used to 500."""
    lim = _armed()
    try:
        resp = client.post(
            "/api/v2/auth/forgot-password", json={"email": "nobody@x.com"},
        )
    finally:
        _disarm(lim)
    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok"}


def test_every_limited_route_is_safe_without_headers():
    """Any route the limiter wraps is safe ONLY because headers are
    off; if someone turns them back on, every limited route that
    returns a model or dict without a ``response: Response`` param
    breaks again. List them so the failure names the routes."""
    import inspect
    from fastapi.routing import APIRoute
    from starlette.responses import Response
    from api.Core.RateLimit import limiter as slow_limiter
    from api.main import create_app

    limited = set(slow_limiter._route_limits)
    unsafe = []
    for route in create_app().routes:
        if not isinstance(route, APIRoute):
            continue
        fn = route.endpoint
        name = f"{fn.__module__}.{fn.__name__}"
        if name not in limited:
            continue
        params = inspect.signature(fn).parameters
        ret = inspect.signature(fn).return_annotation
        returns_response = inspect.isclass(ret) and issubclass(ret, Response)
        if "response" not in params and not returns_response:
            unsafe.append(route.path)
    assert limited, "no rate-limited routes found; did the registry move?"
    # The scan must see the route the live store hit, or it is
    # checking nothing.
    assert "/transfers" in unsafe
    assert slow_limiter._headers_enabled is False, (
        "Rate-limit headers were turned on; these routes would 500 after "
        f"committing: {sorted(unsafe)}"
    )


# ── Whose address a limit counts (2026-10-21) ────────────────
# Behind Render every request arrives from Render's proxy. Keying on
# the socket peer put every customer in one bucket; the key is now
# the address Render's proxy saw, the rightmost X-Forwarded-For.


def _req(headers=None, peer="10.0.0.1"):
    from starlette.requests import Request
    scope = {
        "type": "http", "method": "GET", "path": "/",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        "client": (peer, 1234),
    }
    return Request(scope)


def test_limit_key_is_the_address_the_proxy_saw():
    from api.Core.RateLimit import client_ip
    assert client_ip(_req({"X-Forwarded-For": "203.0.113.7"})) == "203.0.113.7"


def test_limit_key_ignores_a_forged_left_entry():
    """A client can send its own X-Forwarded-For; the proxy appends
    the real address after it. Only that last entry counts, so a
    forged header never buys a fresh bucket."""
    from api.Core.RateLimit import client_ip
    forged = _req({"X-Forwarded-For": "1.2.3.4, 203.0.113.7"})
    assert client_ip(forged) == "203.0.113.7"


def test_limit_key_without_a_proxy_is_the_socket_peer():
    from api.Core.RateLimit import client_ip
    assert client_ip(_req(peer="127.0.0.1")) == "127.0.0.1"
    assert client_ip(_req({"X-Forwarded-For": " "}, peer="127.0.0.1")) == "127.0.0.1"


def test_two_customers_behind_the_proxy_have_separate_login_buckets(client):
    lim = _armed()
    try:
        a = [client.post("/api/v2/auth/login",
                         json={"username": "x", "password": "y", "store_id": 0},
                         headers={"X-Forwarded-For": "198.51.100.1"}).status_code
             for _ in range(11)]
        b = client.post("/api/v2/auth/login",
                        json={"username": "x", "password": "y", "store_id": 0},
                        headers={"X-Forwarded-For": "198.51.100.2"}).status_code
    finally:
        _disarm(lim)
    assert a[-1] == 429
    assert b != 429


@pytest.mark.parametrize("path", [
    "/api/v2/auth/store-by-slug/nope", "/api/v2/auth/referral/NOPE",
])
def test_public_lookups_are_limited(client, path):
    lim = _armed()
    try:
        statuses = [client.get(path).status_code for _ in range(61)]
    finally:
        _disarm(lim)
    assert statuses[0] == 404
    assert statuses[-1] == 429


def test_tv_pair_init_is_limited_and_answers_429_json(client):
    lim = _armed()
    try:
        statuses = [client.post("/api/tv-pair/init", json={}).status_code
                    for _ in range(21)]
        last = client.post("/api/tv-pair/init", json={})
    finally:
        _disarm(lim)
    assert statuses[0] == 200
    assert statuses[-1] == 429
    assert last.status_code == 429
    assert "Too many requests" in last.get_json()["detail"]
