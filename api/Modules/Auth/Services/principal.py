"""Principal-resolution helpers shared across the FastAPI controllers.

``get_principal`` (in ``api.Modules.Auth.Controllers``) returns the
decoded JWT claims dict; these helpers take that dict + a session
and return the canonical ``User`` row when needed for audit /
mutation paths.

Lives in Auth/Services rather than Auth/Controllers because it's
called from non-Auth modules (Announcements, FeatureFlags,
Superadmin) and importing controllers from controllers makes the
dependency graph harder to reason about. Services are import-safe
from anywhere.
"""
from fastapi import HTTPException
from sqlalchemy.orm import Session

from api.Modules.Auth.Models import User
from typing import Any
from api.Core.Clock import utc_now


def resolve_store_scope(claims: dict[str, Any]) -> int:
    """Extract the JWT principal's `store_id`, or 403.

    Used by the Admin / Monthly / BankSync controllers (and any
    other module gated on "you must be signed in to a specific
    store"). The detail message is intentionally generic — the
    SPA route the user is on supplies the page-specific context
    in its empty state.
    """
    sid = claims.get("store_id")
    if sid is None:
        role = claims.get("role", "")
        if role == "owner":
            detail = (
                "This endpoint requires a store scope. "
                "Use the /owner/* endpoints instead."
            )
        else:
            detail = (
                "JWT does not carry a store scope. "
                "Sign in to a specific store first."
            )
        raise HTTPException(status_code=403, detail=detail)
    return int(sid)


def resolve_superadmin_user(db: Session, claims: dict[str, Any]) -> User:
    """Resolve JWT claims → ``User`` row, gated on role=superadmin.

    Used by the mutation endpoints across the Superadmin /
    Announcements / FeatureFlags modules so the audit trail can
    stamp ``admin_id`` + ``admin_name`` from canonical DB values
    (not whatever the JWT happens to carry). Read-only superadmin
    endpoints continue to call the cheaper claim-only guard
    (``role == "superadmin"``) since they don't audit.

    Raises 403 when the principal isn't a superadmin, 401 when
    the JWT subject is missing or doesn't resolve to a User row.
    """
    if claims.get("role") != "superadmin":
        raise HTTPException(
            status_code=403, detail="Superadmin scope required.",
        )
    sub = claims.get("sub")
    if sub is None:
        raise HTTPException(
            status_code=401, detail="JWT is missing the subject claim.",
        )
    user = db.get(User, int(sub))
    if user is None:
        raise HTTPException(
            status_code=401,
            detail="JWT subject does not resolve to a user.",
        )
    return user


def has_permission(claims: dict[str, Any], resource: str, action: str) -> bool:
    """Live permission check via Casbin. Permission changes take
    effect immediately — no JWT refresh needed. The JWT subject is
    threaded through so per-user overlays (R-1) are enforced live,
    not just baked into the token at login."""
    if claims.get("role") == "superadmin":
        return True
    from api.Core.Permissions import check_permission
    sub = claims.get("sub")
    return check_permission(
        claims.get("role", ""), claims.get("store_id"), resource, action,
        user_id=int(sub) if sub is not None else None,
    )


def require_permission(
    claims: dict[str, Any], resource: str, action: str,
) -> None:
    """Raise 403 if the principal lacks permission (live Casbin check)."""
    if not has_permission(claims, resource, action):
        raise HTTPException(
            status_code=403,
            detail=f"Missing permission: {resource}.{action}",
        )


def revoke_refresh_tokens(
    db: Session,
    *,
    user_id: int | None = None,
    store_id: int | None = None,
    role: str | None = None,
) -> int:
    """Revoke live refresh tokens on ``db``'s transaction and return
    how many. The ONE session-revoking write: every route that
    changes what a person may do, or who they are, ends a session
    through here so the next request re-authenticates against the
    new state (``_require_live_principal`` refuses the old access
    token at once).

    Pick the scope by keyword:

    * ``user_id`` — one person, active or not (a deactivated login
      is exactly the one to sign out).
    * ``role`` — every ACTIVE login of that role, at ``store_id``
      when given, platform-wide when ``store_id`` is None (a global
      matrix edit).

    Exactly one scope is required; a call with neither would revoke
    the whole platform, so it refuses."""
    from api.Modules.Auth.Models import RefreshToken
    if user_id is None and role is None:
        raise ValueError("revoke_refresh_tokens needs user_id or role")
    now = utc_now()
    q = db.query(RefreshToken).filter(
        RefreshToken.revoked_at.is_(None),
        RefreshToken.expires_at > now,
    )
    if user_id is not None:
        q = q.filter(RefreshToken.user_id == int(user_id))
    else:
        people = db.query(User.id).filter(
            User.role == role, User.is_active.is_(True),
        )
        if store_id is not None:
            people = people.filter(User.store_id == int(store_id))
        q = q.filter(RefreshToken.user_id.in_(people))
    count = q.update({"revoked_at": now}, synchronize_session="fetch")
    db.flush()
    return int(count)
