"""The accountant's route list: the second lock on a view-only role.

An accountant (a store's bookkeeper or CPA, idea D1) holds a FIXED
grant set in ``FIXED_ROLE_GRANTS`` — Reports and the monthly P&L,
view only. That is the first lock, and it covers every route gated
by ``require_permission``. Plenty of routes are not: they answer any
signed-in store user (the dashboard, the time clock punch, the
support inbox, the profile) and decide by ``role`` inside, often
with an ``admin``/``employee`` branch and a fallback.

So ``get_principal`` also runs every accountant request through
``require_accountant_route``: the request's route must be on the
list below, or the answer is 403 before the route body runs. A
route added to the app later is refused to accountants until
someone puts it here on purpose. ``tests/Core/test_accountant_role.py``
walks every route in the app and checks the list both ways.

Keys are the route TEMPLATES as the API router declares them
(``/monthly/{year}/{month}``), never the concrete path, so a path
parameter can never be used to reach a route that is not listed.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request

ACCOUNTANT_ROLE = "accountant"

# (method, route template) an accountant may call. Reports are
# matched by prefix below; everything else is listed one by one.
ACCOUNTANT_ROUTES: frozenset[tuple[str, str]] = frozenset({
    # Their own session and account.
    ("GET", "/auth/session-status"),
    ("GET", "/auth/me"),
    ("GET", "/auth/profile"),
    ("PUT", "/auth/profile"),
    ("POST", "/auth/change-password"),
    ("GET", "/auth/sessions"),
    ("DELETE", "/auth/sessions/others"),
    ("DELETE", "/auth/sessions/{session_id}"),
    ("GET", "/auth/activity"),
    ("GET", "/auth/account/export"),
    # The in-app store switch: their own login at another store
    # their sign-in is linked to (Auth Services/linked_logins.py).
    # The routes answer an accountant from its own branch; adding a
    # store (POST /auth/my-stores) stays owner-only.
    ("GET", "/auth/my-stores"),
    ("POST", "/auth/switch-store"),
    # Settings → Security: their own passkeys.
    ("GET", "/auth/passkeys"),
    ("POST", "/auth/passkeys/register/begin"),
    ("POST", "/auth/passkeys/register/finish"),
    ("DELETE", "/auth/passkeys/{passkey_id}"),
    # The banner every signed-in page shows.
    ("GET", "/announcements/active"),
    # Monthly P&L, view only.
    ("GET", "/monthly/months"),
    ("GET", "/monthly/labels"),
    ("GET", "/monthly/{year}/{month}"),
    # Tax pack (the ZIP and its year picker).
    ("GET", "/admin/tax-export/years"),
    ("GET", "/admin/tax-export.zip"),
    # The report list itself.
    ("GET", "/reports"),
})

# Every report and its CSV lives under this prefix and only answers
# GET; each one is also gated by ``reports.read``.
ACCOUNTANT_ROUTE_PREFIXES: tuple[tuple[str, str], ...] = (
    ("GET", "/reports/"),
)

REFUSED_DETAIL = "An accountant sign-in can only view reports, the monthly P&L and the tax pack."


def accountant_may_call(method: str, route_path: str) -> bool:
    """Is ``method route_path`` (a route template) on the list?"""
    method = method.upper()
    if method == "HEAD":
        method = "GET"
    if (method, route_path) in ACCOUNTANT_ROUTES:
        return True
    return any(
        method == m and route_path.startswith(prefix)
        for m, prefix in ACCOUNTANT_ROUTE_PREFIXES
    )


def require_accountant_route(request: Request, claims: dict[str, Any]) -> None:
    """403 unless an accountant's request targets a listed route.
    Other roles pass straight through."""
    if str(claims.get("role") or "") != ACCOUNTANT_ROLE:
        return
    route = request.scope.get("route")
    route_path = getattr(route, "path", None)
    # No matched route template means we cannot tell what this is:
    # refuse rather than guess from the raw URL.
    if not isinstance(route_path, str) or not accountant_may_call(
        request.method, route_path,
    ):
        raise HTTPException(status_code=403, detail=REFUSED_DETAIL)


__all__ = [
    "ACCOUNTANT_ROLE", "ACCOUNTANT_ROUTES", "ACCOUNTANT_ROUTE_PREFIXES",
    "REFUSED_DETAIL", "accountant_may_call", "require_accountant_route",
]
