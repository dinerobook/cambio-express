"""Linked accountant logins — one sign-in, every store the person's
password opens, switched from inside the app.

An accountant has one ``User`` row per store (the owner's "Add user
to stores" makes them, all with the same identifier and password).
Before this, seeing another store meant signing out and picking it
on the sign-in page. Now the sign-in itself proves which of those
rows belong to the person: every other ACCOUNTANT row whose
identifier AND password check out at that moment is linked to the
new browser session, by giving it a refresh row with the SAME
``session_id``. No table, no column, no new token kind.

The rules (``api/Modules/Auth/INVARIANTS.md``, "Linked accountant
logins"):

* **Proof is the password, at sign-in.** Same e-mail is not enough:
  a store admin can create an accountant login with anybody's
  e-mail, so an identifier match alone would let them walk into a
  store they don't run. Only rows the typed password opened are
  linked.
* **Accountant to accountant only.** Both the signed-in row and the
  target row must be active ``role="accountant"`` logins at an
  active store. A promoted, demoted or deactivated row drops out at
  once (the role check here, plus the revoke that every such edit
  already does).
* **Each store keeps its own say.** A link is a refresh row of THAT
  store's login, so the store's admin ends it the usual ways
  (deactivate, change role, reset password, revoke sessions); the
  other stores are untouched.
* **One sign-in ends together.** Logout and Account → Devices sign
  the whole browser session out, every linked store with it
  (``Services/sessions.py``, ``refresh.revoke_session_chain``).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from api.Core.Clock import utc_now
from api.Core.Permissions.accountant import ACCOUNTANT_ROLE
from api.Modules.Auth.Models import RefreshToken, User


def linked_accountant_ids(
    db: Session, *, user_id: int, role: str, username: str, password: str,
) -> list[int]:
    """The OTHER accountant logins this sign-in's identifier and
    password open, at stores that are not disabled. Empty unless
    the person who just signed in is an accountant.

    Called only after the sign-in itself succeeded, so the extra
    password checks reveal nothing the caller doesn't already know.
    """
    if role != ACCOUNTANT_ROLE:
        return []
    from api.Modules.Auth.Services.login import _authenticating_users
    from api.Modules.Auth.Services.store_access import (
        user_locked_out_by_store,
    )
    return [
        int(u.id)
        for u in _authenticating_users(db, username, password)
        if u.id != user_id
        and u.role == ACCOUNTANT_ROLE
        and u.store_id is not None
        and not user_locked_out_by_store(db, u)
    ]


def link_session(
    db: Session, *, session_id: str, user_ids: list[int], ttl_seconds: int,
    user_agent: str = "", ip_address: str = "",
) -> None:
    """Give each linked login a refresh row in this browser
    session. Same lifetime as the sign-in's own row, so the whole
    sign-in expires together."""
    from api.Modules.Auth.Services.refresh import issue
    for uid in user_ids:
        issue(
            db, user_id=uid, ttl_seconds=ttl_seconds,
            user_agent=user_agent, ip_address=ip_address,
            session_id=session_id,
        )


@dataclass(frozen=True)
class LinkedLogin:
    user: Any        # tenancy User row
    store: Any       # its Store row
    refresh: RefreshToken  # the live row that links it to the session


def linked_logins(db: Session, claims: dict[str, Any]) -> list[LinkedLogin]:
    """Every accountant login (the caller's own included) this
    browser session may switch to, by store name. Empty for any
    other role and for a token without a session (impersonation)."""
    if str(claims.get("role") or "") != ACCOUNTANT_ROLE:
        return []
    sid = claims.get("sid")
    if not sid:
        return []
    from api.Modules.Tenancy.Models import Store
    from api.Modules.Auth.Services.store_access import store_is_active
    now = utc_now()
    rows = (
        db.query(RefreshToken, User, Store)
          .join(User, User.id == RefreshToken.user_id)
          .join(Store, Store.id == User.store_id)
          .filter(
              RefreshToken.session_id == str(sid),
              RefreshToken.revoked_at.is_(None),
              RefreshToken.expires_at > now,
              User.role == ACCOUNTANT_ROLE,
              User.is_active.is_(True),
          )
          .order_by(Store.name, RefreshToken.id.desc())
          .all()
    )
    out: list[LinkedLogin] = []
    seen: set[int] = set()
    for refresh, user, store in rows:
        if user.id in seen or not store_is_active(store):
            continue
        seen.add(user.id)
        out.append(LinkedLogin(user=user, store=store, refresh=refresh))
    return out


__all__ = [
    "LinkedLogin", "link_session", "linked_accountant_ids", "linked_logins",
]
