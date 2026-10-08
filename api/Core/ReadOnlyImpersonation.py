"""Refuse writes on a read-only impersonation token.

``POST /superadmin/impersonate/{id}`` with ``mode: read_only`` mints
a token whose ``impersonation_mode`` claim is ``read_only``: the
superadmin wants to SEE what the customer sees without being able
to change a number in their books. Every non-safe request on such a
token is answered here with a 403 and ``reason:
read_only_impersonation`` (the SPA shows why), before any route runs.

Two exemptions: ``/auth/`` (logout / refresh carry no data) and the
route that ends the impersonation. Nothing else — not even the
"write-exempt" paths of the subscription gate, which exist so a
lapsed store can still file a ticket; a read-only viewer files
nothing.

Fails open on anything it cannot decode: a bad token is the auth
layer's 401, not this gate's problem.
"""
from __future__ import annotations

from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from api.Core.Subscription import SAFE_METHODS

READ_ONLY_MODE = "read_only"
READ_ONLY_REASON = "read_only_impersonation"
READ_ONLY_MESSAGE = (
    "This is a read-only view of the customer's account. Exit the "
    "impersonation, or start it again as a full sign-in, to make changes."
)
EXEMPT_PREFIXES = ("/auth/", "/superadmin/impersonate/stop")


def read_only_claims(request: Request) -> dict[str, Any] | None:
    """The decoded claims when the request carries a read-only
    impersonation token, else None."""
    try:
        from api.Modules.Auth.Services.jwt_issuer import decode_access_token
    except Exception:
        return None
    token = None
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1].strip() or None
    if token is None:
        token = request.cookies.get("db_access_token") or None
    if token is None:
        return None
    try:
        claims = decode_access_token(token)
    except Exception:
        return None
    if claims.get("impersonation_mode") != READ_ONLY_MODE:
        return None
    return dict(claims)


class ReadOnlyImpersonationMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Any) -> Any:
        if request.method in SAFE_METHODS:
            return await call_next(request)
        path = request.url.path
        if path.startswith(EXEMPT_PREFIXES):
            return await call_next(request)
        if read_only_claims(request) is None:
            return await call_next(request)
        return JSONResponse(
            status_code=403,
            content={"detail": READ_ONLY_MESSAGE, "reason": READ_ONLY_REASON},
        )


__all__ = [
    "READ_ONLY_MESSAGE", "READ_ONLY_MODE", "READ_ONLY_REASON",
    "ReadOnlyImpersonationMiddleware", "read_only_claims",
]
