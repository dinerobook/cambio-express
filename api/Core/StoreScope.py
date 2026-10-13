"""Which stores a request may read or write when the store comes
from the URL or query string.

A route that takes ``store_id`` / ``store_ids`` from the client must
run it through here before touching data, otherwise any signed-in
person can read (or write) another tenant's rows by editing the URL.
The rule follows the role on the token:

* superadmin: any store (platform scope).
* owner: only stores under their owner umbrella.
* admin / employee (including an owner's switch-store token, which
  is ``role=admin``): only the store on the token.

A store outside the caller's scope is a 403. ``tests/Core/
test_store_scope_routes.py`` walks every route that takes a store id
from the client and fails when one skips this check.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session


def authorize_store_ids(
    db: Session, claims: dict[str, Any], requested_store_ids: list[int],
) -> list[int]:
    """Resolve the final list of store_ids the caller is allowed to query.

    An empty request means "every store in scope": all stores for a
    superadmin (the services read that as no filter), the umbrella
    for an owner, the token's store for everyone else."""
    from api.Modules.Owners.Services import owner_store_ids
    from api.Modules.Tenancy.Models import User

    role = claims.get("role")
    user_id = claims.get("sub")
    store_id = claims.get("store_id")

    if role == "superadmin":
        return list(requested_store_ids)
    if role == "owner":
        u = db.get(User, int(user_id)) if user_id else None
        allowed = set(owner_store_ids(db, u)) if u else set()
        if not requested_store_ids:
            return list(allowed)
        scoped = [sid for sid in requested_store_ids if sid in allowed]
        if not scoped:
            raise HTTPException(
                status_code=403,
                detail="Requested store_ids fall outside your owner umbrella.",
            )
        return scoped
    if role in ("admin", "employee"):
        if store_id is None:
            raise HTTPException(status_code=403, detail="No store on token.")
        own = int(store_id)
        if any(int(sid) != own for sid in requested_store_ids):
            raise HTTPException(
                status_code=403,
                detail="Cannot query store_ids outside your own store.",
            )
        return [own]
    raise HTTPException(status_code=403, detail="Unknown role.")


def authorize_store_id(
    db: Session, claims: dict[str, Any], store_id: int,
) -> int:
    """Single-store form: return ``store_id`` when the caller may use
    it, else 403."""
    if store_id not in authorize_store_ids(db, claims, [store_id]) and (
        claims.get("role") != "superadmin"
    ):
        raise HTTPException(status_code=403, detail="Store outside your scope.")
    return int(store_id)


__all__ = ["authorize_store_id", "authorize_store_ids"]
