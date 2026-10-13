"""The superadmin "Disable store" switch — what it actually blocks.

``Store.is_active`` used to be checked only by the public slug
lookup, so a disabled store's staff kept signing in and saving.
These helpers are the one place the rule lives; login, refresh,
the live-principal check and ``/auth/switch-store`` all ask here.

The rule (see ``api/Modules/Auth/INVARIANTS.md``, "Disabled
stores"):

* a store is disabled only when ``is_active`` is literally False.
  The column is nullable with no server default, so a NULL row
  (never written through the ORM) counts as active;
* a disabled store refuses its store-scoped people — every role
  that is not ``owner``, ``superadmin`` or store-less platform
  staff;
* owners keep their umbrella login but cannot enter the store;
* superadmin impersonation (``impersonated_by`` claim) is exempt so
  support can still look at the store.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

STORE_DISABLED_MESSAGE = "This store has been disabled. Contact support."

# Roles a disabled store never locks out: owners keep the umbrella
# view, the superadmin runs the platform.
_UNAFFECTED_ROLES = frozenset({"owner", "superadmin"})


def store_is_active(store: Any) -> bool:
    """True unless the store row says ``is_active=False``. NULL is
    active (legacy / raw-SQL rows); a missing row is not this
    helper's call."""
    return getattr(store, "is_active", None) is not False


def store_id_is_disabled(db: Session, store_id: Any) -> bool:
    """True when ``store_id`` names a store that has been disabled."""
    if store_id is None:
        return False
    try:
        sid = int(store_id)
    except (TypeError, ValueError):
        return False
    from api.Modules.Tenancy.Models import Store
    store = db.get(Store, sid)
    return store is not None and not store_is_active(store)


def user_locked_out_by_store(db: Session, user: Any) -> bool:
    """True when ``user`` may not sign in because their store is
    disabled. Owners and the superadmin are never locked out here;
    store-less platform logins (``store_id IS NULL``) have no store
    to be disabled."""
    if (getattr(user, "role", "") or "") in _UNAFFECTED_ROLES:
        return False
    return store_id_is_disabled(db, getattr(user, "store_id", None))


def claims_locked_out_by_store(db: Session, claims: dict[str, Any]) -> bool:
    """True when an access token is scoped to a disabled store and
    is not exempt. Exempt: superadmin impersonation (support must
    be able to look) and the owner's base token (``role=owner``),
    whose umbrella view stays open. An owner's switch-store token
    (``role=admin`` + ``owner_id``) IS refused — it is a store
    session like any other."""
    if claims.get("impersonated_by") is not None:
        return False
    if str(claims.get("role") or "") in _UNAFFECTED_ROLES:
        return False
    return store_id_is_disabled(db, claims.get("store_id"))
