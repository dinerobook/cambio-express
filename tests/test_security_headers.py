"""Tests for security headers middleware (CSP, frame options, etc.)."""


def test_csp_header_present(client):
    resp = client.get("/api/v2/auth/refresh")
    csp = resp.headers.get("content-security-policy", "")
    assert "default-src 'self'" in csp


def test_csp_allows_stripe(client):
    """Stripe Checkout iframe needs js.stripe.com."""
    resp = client.get("/api/v2/auth/refresh")
    csp = resp.headers.get("content-security-policy", "")
    assert "js.stripe.com" in csp
    assert "checkout.stripe.com" in csp


def test_csp_allows_google_fonts(client):
    """Google Fonts CSS + font files need explicit allowance."""
    resp = client.get("/api/v2/auth/refresh")
    csp = resp.headers.get("content-security-policy", "")
    assert "fonts.googleapis.com" in csp
    assert "fonts.gstatic.com" in csp


def test_clickjacking_blocked(client):
    """X-Frame-Options + CSP frame-ancestors both block iframe embed."""
    resp = client.get("/api/v2/auth/refresh")
    assert resp.headers.get("x-frame-options") == "DENY"
    csp = resp.headers.get("content-security-policy", "")
    assert "frame-ancestors 'none'" in csp


def test_mime_sniffing_blocked(client):
    resp = client.get("/api/v2/auth/refresh")
    assert resp.headers.get("x-content-type-options") == "nosniff"


def test_referrer_policy_set(client):
    resp = client.get("/api/v2/auth/refresh")
    assert resp.headers.get("referrer-policy") == "strict-origin-when-cross-origin"


def test_permissions_policy_locks_down_apis(client):
    resp = client.get("/api/v2/auth/refresh")
    pp = resp.headers.get("permissions-policy", "")
    assert "camera=()" in pp
    assert "microphone=()" in pp


# ── Every surface, not just the API ─────────────────────────────
# Before 2026-10-21 only /api/v2 carried these: the SPA shell (where
# people type their password), the landing page, the TV board and
# /static went out bare, so the sign-in page could be framed by any
# site (clickjacking).

import pytest  # noqa: E402

PAGE_PATHS = [
    "/",                          # landing (redirects into the SPA)
    "/app/login",                 # SPA shell
    "/offline",                   # service-worker offline page
    "/sw.js",
    "/static/design-tokens.css",
    "/tv/not-a-real-token",       # public TV board (404 page)
    "/api/tv-pair/status",        # Fire TV pairing JSON
    "/some/legacy/path",          # cutover redirect
]


@pytest.mark.parametrize("path", PAGE_PATHS)
def test_every_page_refuses_framing(client, path):
    resp = client.get(path)
    assert resp.headers.get("x-frame-options") == "DENY", path
    assert "frame-ancestors 'none'" in resp.headers.get("content-security-policy", ""), path


@pytest.mark.parametrize("path", PAGE_PATHS)
def test_every_page_carries_the_common_headers(client, path):
    resp = client.get(path)
    assert resp.headers.get("x-content-type-options") == "nosniff", path
    assert resp.headers.get("referrer-policy") == "strict-origin-when-cross-origin", path
    assert "camera=()" in resp.headers.get("permissions-policy", ""), path
    assert resp.headers.get("strict-transport-security") == "max-age=31536000", path


def test_api_keeps_its_full_csp(client):
    """The page wrapper never overwrites the API's own CSP with the
    narrower page one, and never sends the header twice."""
    resp = client.get("/api/v2/health")
    assert len(resp.headers.get_list("content-security-policy")) == 1
    csp = resp.headers["content-security-policy"]
    assert "script-src 'self' 'unsafe-inline' https://js.stripe.com" in csp
    assert resp.headers.get("strict-transport-security") == "max-age=31536000"


def test_pages_get_the_narrow_csp_not_a_script_allowlist(client):
    """The SPA loads Stripe.js for bank connections; a script
    allowlist on pages needs testing against the live Stripe flow
    first, so pages carry only framing / base / plugin rules."""
    csp = client.get("/offline").headers["content-security-policy"]
    assert "script-src" not in csp
    assert "base-uri 'self'" in csp
    assert "object-src 'none'" in csp


def test_wrapper_passes_lifespan_through_untouched():
    import asyncio

    from api.Core.Observability.security_headers import with_page_security_headers

    seen = []

    async def inner(scope, receive, send):
        seen.append(scope["type"])
        await send({"type": "lifespan.startup.complete"})

    sent = []

    async def send(msg):
        sent.append(msg)

    asyncio.run(with_page_security_headers(inner)({"type": "lifespan"}, None, send))
    assert seen == ["lifespan"]
    assert sent == [{"type": "lifespan.startup.complete"}]
