"""One path for every route that replaces a role's permission matrix.

Three controllers (Admin, Owners, Superadmin) used to carry their own
copy of the same loop — parse the body, check each role, write, audit,
revoke — and the copies had drifted: two of them silently dropped a
role the caller may not edit, one audited an empty body, and every
one of them wrote the first role before checking the second. This
module is the single copy. A route does three things: build its
``editable_roles`` list (that is the policy decision it owns), call
``apply_matrix_update`` / ``apply_matrix_reset`` on its own ``db``
session, then audit and commit. Nothing is persisted until that
commit, and the live policy reloads only after it.

The request bodies live here too so the three routes cannot drift
apart in what they accept. A body that does not fit is a 422 before
the route body runs; a role or cell the caller may not touch is a
403 before the first write.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from sqlalchemy.orm import Session

from api.Core.Permissions import (
    RBAC_ACTIONS, RBAC_RESOURCES, reset_store_to_defaults,
    set_global_permissions, set_store_permissions,
)

RoleMatrix = dict[str, dict[str, StrictBool]]
"""``{resource: {action: allowed}}`` — one role's full grid. Strict
so ``"yes"`` is a 422, not a grant."""


class PermissionMatrixBody(BaseModel):
    """``PUT …/permissions`` — replace the matrix of one or more
    roles. Every role named is replaced whole; a role left out is
    untouched."""

    model_config = ConfigDict(extra="forbid")

    matrix: dict[str, RoleMatrix] = Field(..., min_length=1)


class ResetRoleBody(BaseModel):
    """``POST …/permissions/reset`` — drop one role's per-store rows."""

    model_config = ConfigDict(extra="forbid")

    role: str = Field(..., min_length=1, max_length=40)


class RoleMatrixBody(BaseModel):
    """A body carrying exactly one role's grid (a person's custom
    access, a saved role)."""

    model_config = ConfigDict(extra="forbid")

    matrix: RoleMatrix


def validate_role_matrix(matrix: RoleMatrix, *, where: str = "matrix") -> None:
    """422 on a resource or action the platform does not have. The
    writer would silently drop such a cell, and a client sending
    one is out of date — telling it beats a save that half-applies."""
    for resource, actions in matrix.items():
        if resource not in RBAC_RESOURCES:
            raise HTTPException(
                status_code=422,
                detail=f"{where}: unknown resource {resource!r}.",
            )
        for action in actions:
            if action not in RBAC_ACTIONS:
                raise HTTPException(
                    status_code=422,
                    detail=f"{where}.{resource}: unknown action {action!r}.",
                )


def _require_editable(role: str, editable_roles: Iterable[str]) -> None:
    if role not in editable_roles:
        raise HTTPException(
            status_code=403, detail=f"Cannot edit {role} permissions",
        )


def apply_matrix_update(
    db: Session,
    *,
    store_id: int | None,
    matrix: dict[str, RoleMatrix],
    editable_roles: Iterable[str],
    check_ceiling: Callable[[RoleMatrix], None] | None = None,
) -> list[str]:
    """Validate every role in ``matrix``, then write them all on
    ``db``'s transaction and revoke the affected roles' sessions.

    ``store_id=None`` edits the GLOBAL layer (superadmin). The
    caller audits and commits; until it does, nothing has changed.
    Returns the roles written, sorted, for the audit line."""
    editable = tuple(editable_roles)
    for role, rows in matrix.items():
        _require_editable(role, editable)
        validate_role_matrix(rows, where=f"matrix.{role}")
        if check_ceiling is not None:
            check_ceiling(rows)
    for role, rows in matrix.items():
        if store_id is None:
            set_global_permissions(role, rows, session=db)
        else:
            set_store_permissions(store_id, role, rows, session=db)
    from api.Modules.Auth.Services.principal import revoke_refresh_tokens
    for role in matrix:
        revoke_refresh_tokens(db, store_id=store_id, role=role)
    return sorted(matrix)


def apply_matrix_reset(
    db: Session,
    *,
    store_id: int,
    role: str,
    editable_roles: Iterable[str],
) -> None:
    """Drop ``role``'s per-store rows on ``db``'s transaction and
    revoke that role's sessions at the store. Caller audits and
    commits."""
    _require_editable(role, tuple(editable_roles))
    reset_store_to_defaults(store_id, role, session=db)
    from api.Modules.Auth.Services.principal import revoke_refresh_tokens
    revoke_refresh_tokens(db, store_id=store_id, role=role)
