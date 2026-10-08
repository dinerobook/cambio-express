"""Who may manage whom: the rank rule for team and access edits.

Every route that changes another person's standing at a store
(their role, password, active flag, custom access, saved role)
goes through here. The rule is deliberately small so a reviewer
can hold all of it in their head:

* Ranks: ``employee`` < ``admin`` < ``owner`` < ``superadmin``.
  An owner's switch-store token (``role=admin`` plus an
  ``owner_id`` claim naming the subject) counts as ``owner``.
* You may manage people at or below your own rank, never above.
  So an admin can manage admins and employees but not the owner
  row at the home store; an employee who was given the Team
  permission can manage other employees only.
* You may assign roles at or below your own rank only.
* You may not grant access you do not hold yourself. Admins and
  owners hold everything at their store, so this bites only on
  employee-rank actors: the grid they write for a colleague, a
  saved role they create, or a role matrix they edit must stay
  inside their own effective grants.

Editing yourself is governed by the self-edit guards in the
routes (no self demotion, no self overlay), not by rank.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

ROLE_RANK: dict[str, int] = {
    "employee": 0,
    "admin": 1,
    "owner": 2,
    "superadmin": 3,
}

# Roles a store-level route may ever assign. Owner rows are made
# by signup and superadmin tooling only.
ASSIGNABLE_ROLES: tuple[str, ...] = ("admin", "employee")


def rank_of(role: str | None) -> int:
    """Unknown or blank roles rank below employee, so a malformed
    row can never outrank anyone and can always be cleaned up."""
    return ROLE_RANK.get((role or "").strip(), -1)


def actor_rank_role(claims: Mapping[str, Any]) -> str:
    """The role the actor ranks as. A switch-store token is the
    owner acting inside one of their stores."""
    role = str(claims.get("role") or "")
    owner_id = claims.get("owner_id")
    if role == "admin" and owner_id is not None:
        if str(owner_id) == str(claims.get("sub")):
            return "owner"
    return role


def can_manage(claims: Mapping[str, Any], target_role: str | None) -> bool:
    """May this actor change a person holding ``target_role``?"""
    return rank_of(actor_rank_role(claims)) >= rank_of(target_role)


def assignable_roles(claims: Mapping[str, Any]) -> list[str]:
    """Roles this actor may give to someone else."""
    ceiling = rank_of(actor_rank_role(claims))
    return [r for r in ASSIGNABLE_ROLES if rank_of(r) <= ceiling]


def can_assign_role(claims: Mapping[str, Any], role: str | None) -> bool:
    return (role or "").strip() in assignable_roles(claims)


def matrix_grants(matrix: Mapping[str, Any]) -> set[tuple[str, str]]:
    """The (resource, action) pairs a resource x action matrix
    switches on, with the implied-read rule applied so the check
    sees what would actually be enforced."""
    from api.Core.Permissions import _with_implied_read
    grants: set[tuple[str, str]] = set()
    for resource, actions in matrix.items():
        if not isinstance(actions, Mapping):
            continue
        for action, on in actions.items():
            if on:
                grants.add((str(resource), str(action)))
    return _with_implied_read(grants)


def grant_ceiling(
    claims: Mapping[str, Any], store_id: int,
) -> set[tuple[str, str]] | None:
    """Everything the actor may hand to someone else. ``None`` means
    unbounded (admin rank and above hold the whole store)."""
    if rank_of(actor_rank_role(claims)) >= rank_of("admin"):
        return None
    from api.Core.Permissions import resolve_user_grants
    sub = claims.get("sub")
    if sub is None:
        return set()
    return resolve_user_grants(
        int(sub), str(claims.get("role") or ""), store_id,
    )


def grants_beyond_ceiling(
    claims: Mapping[str, Any], store_id: int,
    grants: Iterable[tuple[str, str]],
) -> list[str]:
    """The ``resource.action`` names in ``grants`` the actor does not
    hold. Empty when the write is within what they may give."""
    ceiling = grant_ceiling(claims, store_id)
    if ceiling is None:
        return []
    return sorted(
        f"{resource}.{action}"
        for resource, action in grants
        if (resource, action) not in ceiling
    )


def matrix_beyond_ceiling(
    claims: Mapping[str, Any], store_id: int, matrix: Mapping[str, Any],
) -> list[str]:
    return grants_beyond_ceiling(claims, store_id, matrix_grants(matrix))


__all__ = [
    "ASSIGNABLE_ROLES", "ROLE_RANK", "actor_rank_role",
    "assignable_roles", "can_assign_role", "can_manage",
    "grant_ceiling", "grants_beyond_ceiling", "matrix_beyond_ceiling",
    "matrix_grants", "rank_of",
]
