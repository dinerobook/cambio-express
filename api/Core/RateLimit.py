"""Shared slowapi Limiter for FastAPI.

A module-level singleton so controllers can import it without
depending on the ``api.main.create_app()`` lifecycle. (Flask had a
twin limiter before PR #550 removed Flask; this is now the sole
limiter.) Storage backend + enable-flag come from the
``RATELIMIT_STORAGE_URI`` / ``RATELIMIT_ENABLED`` env vars — point
``RATELIMIT_STORAGE_URI`` at Redis in prod so the bucket holds
across gunicorn workers.

Tuning lives in the per-route decorators (auth + webhook
controllers); this module only constructs the limiter.
"""
from __future__ import annotations

import os

from slowapi import Limiter
from starlette.requests import Request


_storage = os.environ.get("RATELIMIT_STORAGE_URI", "memory://")
_enabled = os.environ.get("RATELIMIT_ENABLED", "1") not in (
    "0", "false", "False",
)


def client_ip(request: Request) -> str:
    """The address a limit is counted against.

    Behind Render the socket peer is Render's proxy, the same few
    addresses for every customer, so keying on it (slowapi's
    ``get_remote_address``) counted every sign-in on the platform
    against one shared limit: ten sign-in attempts a minute from
    anyone could lock every store out. The proxy appends the address that connected to it to
    ``X-Forwarded-For``; the RIGHTMOST entry is that one. Entries to
    its left come from the client and can be forged, so they are
    never used — a forged header cannot buy a fresh bucket. No
    header (local dev, tests) → the socket peer, as before."""
    fwd = request.headers.get("x-forwarded-for", "")
    last = fwd.rsplit(",", 1)[-1].strip()
    if last:
        return last[:64]
    return request.client.host if request.client else ""


limiter = Limiter(
    key_func=client_ip,
    storage_uri=_storage,
    strategy="fixed-window",
    enabled=_enabled,
    # OFF on purpose. With headers on, slowapi writes X-RateLimit-*
    # onto the response AFTER the route returns, and it raises when
    # the route returned a Pydantic model or dict rather than a
    # Starlette ``Response`` and takes no ``response: Response``
    # parameter. The route had already committed by then, so the
    # caller got a 500 for a write that landed, and a retry wrote it
    # again (live: one New Transfer saved 8 times). Nothing reads
    # these headers; a 429 still answers with its status and body.
    # ``tests/test_rate_limiting.py`` pins this and drives every
    # limited route with the limiter on.
    headers_enabled=False,
)
# slowapi >=0.1.9 reads `RATELIMIT_ENABLED` from os.environ itself
# and stores the raw string, which is truthy (e.g. "0" is truthy in
# Python). Overwrite with an actual bool so the test suite's
# `enabled=False` actually disables the limiter.
limiter.enabled = _enabled
