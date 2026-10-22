"""Security headers middleware.

Adds defense-in-depth HTTP headers to every response:

- Content-Security-Policy: restricts what the browser will execute
  (scripts, styles, images, fonts, iframes, connections). Stops
  XSS at the browser level even if a vulnerability slips through.
- X-Content-Type-Options: blocks MIME-sniffing attacks
- X-Frame-Options: blocks clickjacking via iframe embed
- Referrer-Policy: don't leak referrer URLs to third parties
- Permissions-Policy: opt out of browser APIs we don't use
- Strict-Transport-Security: once a browser has seen the site over
  HTTPS it never tries plain HTTP again (ignored on http://localhost)

Two layers use these:

- ``SecurityHeadersMiddleware`` on the FastAPI app (every
  ``/api/v2`` and ``/webhooks`` response) sends the full CSP.
- ``with_page_security_headers`` wraps the top-level ASGI router in
  ``asgi.py`` so every other response — the SPA shell (where people
  sign in), the landing page, the TV board, ``/static`` — carries the
  same headers. Pages get a narrower CSP (framing, ``<base>``,
  plugins) rather than the script allowlist: the SPA loads Stripe.js
  for bank connections and a script allowlist there is a change to
  test against the live Stripe flow, not one to ship blind.

CSP allowlist accommodates:
- Self-hosted SPA bundle + CSS
- Google Fonts (fonts.googleapis.com + fonts.gstatic.com)
- Stripe Checkout iframe (js.stripe.com + checkout.stripe.com)
- Inline styles (Vite injects some) and inline scripts (theme
  restore in index.html) — both with 'unsafe-inline' until we
  switch to nonce-based CSP
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


_CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://js.stripe.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://api.stripe.com https://*.sentry.io",
    "frame-src 'self' https://js.stripe.com https://checkout.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
])


# What every page may do, short of a script allowlist: never be
# framed (clickjacking on the sign-in form), never rebase relative
# URLs, never load plugins.
_PAGE_CSP = "; ".join([
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
])

# The headers every response carries, API or page.
COMMON_HEADERS: dict[str, str] = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": (
        "camera=(), microphone=(), geolocation=(self), payment=(self)"
    ),
    "Strict-Transport-Security": "max-age=31536000",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        response = await call_next(request)
        response.headers.setdefault("Content-Security-Policy", _CSP)
        for name, value in COMMON_HEADERS.items():
            response.headers.setdefault(name, value)
        return response


ASGIApp = Callable[[dict[str, Any], Any, Any], Awaitable[None]]


def with_page_security_headers(app: ASGIApp) -> ASGIApp:
    """Wrap an ASGI app so each HTTP response it starts carries
    ``COMMON_HEADERS`` and the page CSP. A header the inner app
    already set wins, so the API's full CSP passes through as is."""
    defaults = [
        (k.lower().encode("latin-1"), v.encode("latin-1"))
        for k, v in {**COMMON_HEADERS, "Content-Security-Policy": _PAGE_CSP}.items()
    ]

    async def wrapped(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await app(scope, receive, send)
            return

        async def send_with_headers(message: dict[str, Any]) -> None:
            if message.get("type") == "http.response.start":
                headers = list(message.get("headers") or [])
                present = {k.lower() for k, _ in headers}
                headers += [(k, v) for k, v in defaults if k not in present]
                message = {**message, "headers": headers}
            await send(message)

        await app(scope, receive, send_with_headers)

    return wrapped
