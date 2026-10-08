"""Casbin-backed RBAC permission service.

Replaces the custom three-tier resolution (StoreRoleOverride →
RolePermission → RBAC_DEFAULTS) with a Casbin enforcer backed by
SQLAlchemy.

Policy rows live in the ``casbin_rule`` table (auto-created by the
adapter). Each row is (ptype, v0=role, v1=domain, v2=resource,
v3=action). Domain is ``"global"`` for defaults or ``str(store_id)``
for per-store overrides.

Resolution (``resolve_grants`` is the ONE entry point):
  1. Per-user overlay (subject ``user:<id>``, domain = store_id)
  2. Per-store role rows (domain = store_id) — per-resource overlay
  3. Global role rows (domain = "global") — per-resource overlay
  4. RBAC_DEFAULTS (hardcoded) → only for resources no global row
     mentions, i.e. before the first seed

Superadmin bypasses all checks. A principal with no store scope
(an owner's umbrella token) resolves against the global rows.

Writes: every writer replaces ONE subject's rows in ONE database
transaction (``_replace_subject_rows``) and never goes through the
enforcer's row-by-row API, so a reader on another worker sees the
old set or the new set, never an empty one in between, and two
writers can never leave a union of their rows behind. A writer may
join a caller's SQLAlchemy session so the rows commit together
with the audit entry and whatever else the request changes.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import casbin
from casbin_sqlalchemy_adapter import Adapter as CasbinAdapter, CasbinRule
from sqlalchemy import event, text
from sqlalchemy.orm import Session, sessionmaker

_log = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────

RBAC_RESOURCES = [
    "transfers", "customers", "daily_book", "monthly",
    "batches", "bank_sync", "reports", "settings",
    "users", "time_clock", "return_checks", "lottery",
    "day_close", "catalog",
]
RBAC_ACTIONS = ["create", "read", "update", "delete"]

RBAC_DEFAULTS: dict[str, list[str]] = {
    "admin": [f"{r}.{a}" for r in RBAC_RESOURCES for a in RBAC_ACTIONS],
    "employee": [
        "transfers.create", "transfers.read", "transfers.update",
        "customers.create", "customers.read", "customers.update",
        "daily_book.read",
        "time_clock.create", "time_clock.read",
        "return_checks.read",
        # Cashiers enter the lottery day-close counts.
        "lottery.create", "lottery.read",
        # Cashiers submit their own register/shift close.
        "day_close.create", "day_close.read",
        # Cashiers look items up in the price book; managing the
        # catalog (items + vendors) stays admin-side.
        "catalog.read",
    ],
    "owner": (
        [f"{r}.read" for r in RBAC_RESOURCES]
        + ["settings.create", "settings.update", "settings.delete",
           "users.create"]
    ),
}

LEGACY_ROLE_PERMISSIONS: dict[str, list[str]] = {
    "superadmin": ["platform.admin", "store.admin", "store.employee", "owner.read"],
    # Tickets-only platform role. Deliberately NOT in the
    # superadmin bypasses in check_permission / require_permission /
    # permissions_for — support's whole surface is the Support
    # module, gated by PLATFORM_STAFF_ROLES there.
    "support": ["platform.support"],
    "owner": ["owner.read", "owner.admin"],
    "admin": ["store.admin", "store.employee"],
    "employee": ["store.employee"],
}


# ── Enforcer singleton ─────────────────────────────────────
#
# One enforcer PER PROCESS, and production runs several gunicorn
# workers against one database. Two rules keep them consistent:
#
#   * Writers change rows incrementally (``add_policy`` /
#     ``remove_filtered_policy`` persist each row through the
#     adapter's auto-save) and NEVER call ``save_policy()``. That
#     call rewrites the whole ``casbin_rule`` table from THIS
#     worker's memory, so a worker that had not seen another
#     worker's write silently erased it — a store's Employee-role
#     edit "kept going back to the default" whenever any later
#     permission write landed on the other worker.
#   * Readers re-load from the DB once their copy is older than
#     ``_RELOAD_INTERVAL`` seconds, so a write on one worker is
#     enforced on every worker within that window. A writer
#     reloads right before and after its own write, so what it
#     changes is current the moment it returns.

_enforcer: casbin.Enforcer | None = None
_loaded_at: float = 0.0
_RELOAD_INTERVAL = float(os.environ.get("PERMISSIONS_RELOAD_SECONDS", "2"))


def _model_path() -> str:
    return os.path.join(os.path.dirname(__file__), "model.conf")


def _build_enforcer() -> casbin.Enforcer:
    from api.Core.Database.session import _get_engine
    return casbin.Enforcer(_model_path(), CasbinAdapter(_get_engine()))


def _get_enforcer() -> casbin.Enforcer:
    """Lazy-init the module-level enforcer singleton, re-reading
    the policy from the DB once it is ``_RELOAD_INTERVAL`` old.
    If the prior init failed (or the singleton was reset), try
    again — letting a transient DB hiccup poison the process
    forever was an outage waiting to happen."""
    global _enforcer, _loaded_at
    if _enforcer is None:
        _enforcer = _build_enforcer()
        _loaded_at = time.monotonic()
    elif time.monotonic() - _loaded_at > _RELOAD_INTERVAL:
        try:
            reload_policy()
        except Exception:  # noqa: BLE001 — keep serving the last good copy
            _log.warning(
                "Casbin: periodic policy reload failed; serving the "
                "copy loaded %.0fs ago", time.monotonic() - _loaded_at,
                exc_info=True,
            )
    return _enforcer


def _reset_enforcer() -> None:
    """Drop the singleton so the next call rebuilds it. Used by tests."""
    global _enforcer
    _enforcer = None


def reload_policy() -> None:
    """Re-read all rules from the DB into the in-memory enforcer.
    pycasbin builds the new policy aside and swaps it in, so a
    request checking permissions mid-reload sees the old or the
    new set, never a half-loaded one."""
    global _enforcer, _loaded_at
    if _enforcer is None:
        _enforcer = _build_enforcer()
    else:
        _enforcer.load_policy()
    _loaded_at = time.monotonic()


def _enforcer_for_write() -> casbin.Enforcer:
    """The enforcer with the DB's current rows loaded, for a
    writer about to change them. Starting from a stale copy would
    skip ``add_policy`` for a row memory thinks exists, or keep a
    row in memory the DB no longer has."""
    reload_policy()
    assert _enforcer is not None
    return _enforcer


# ── Internal helpers ───────────────────────────────────────

def _with_implied_read(
    grants: set[tuple[str, str]],
) -> set[tuple[str, str]]:
    """Any write on a resource implies reading it. Every write
    surface shows the data it edits, and the SPA's list / calendar
    pages gate on ``.read`` while their editors gate on the write —
    so "Edit without View" opened the editor but bounced its own
    "back to calendar" button to the dashboard. Applied on every
    resolution path so a matrix saved before the editor coupled the
    boxes still resolves coherently."""
    return grants | {(resource, "read") for resource, _ in grants}


def _normalized_matrix(
    matrix: dict[str, dict[str, bool]],
) -> dict[str, dict[str, bool]]:
    """Write-side twin of ``_with_implied_read``: a saved row with
    any action on also stores ``read``, so what is in ``casbin_rule``
    matches what is enforced."""
    out: dict[str, dict[str, bool]] = {}
    for resource, actions in matrix.items():
        row = dict(actions)
        if any(row.values()):
            row["read"] = True
        out[resource] = row
    return out


def apply_cell_change(
    row: dict[str, bool], action: str, allowed: bool,
) -> None:
    """Set one cell of a matrix row in place, keeping the row
    coherent the way ``toggleMatrixCell`` does in the SPA: granting
    a write grants read, revoking read revokes every write. Every
    cell-level ``changes`` endpoint goes through this so taking View
    away is not silently undone by ``_with_implied_read``."""
    row[action] = allowed
    if action == "read" and not allowed:
        for a in row:
            row[a] = False
    elif action != "read" and allowed:
        row["read"] = True


def _default_grants(role: str) -> set[tuple[str, str]]:
    defaults = RBAC_DEFAULTS.get(role, [])
    return {tuple(p.split(".", 1)) for p in defaults if "." in p}  # type: ignore[misc]


def _global_grants(role: str) -> set[tuple[str, str]]:
    """Global (resource, action) grants for a role.

    Same per-resource overlay as the store layer: a global row
    governs the resource it mentions (a ``__none__`` marker
    mentions it with every action off, which is how "the
    superadmin turned this off for everyone" is stored), and a
    resource no global row mentions falls back to
    ``RBAC_DEFAULTS`` — that is the unseeded case and a resource
    added to the platform after the last global save."""
    e = _get_enforcer()
    mentioned, grants, _legacy = _store_overlay(
        e.get_filtered_policy(0, role, "global"),
    )
    return _with_implied_read(grants) | {
        (resource, action)
        for resource, action in _default_grants(role)
        if resource not in mentioned
    }


def _store_overlay(
    store_rules: list[list[str]],
) -> tuple[set[str], set[tuple[str, str]], bool]:
    """Split a store domain's rows into (mentioned resources,
    grants, legacy_all_off). ``__none__`` action rows mention a
    resource with zero grants; the legacy ``__override_active__``
    sentinel marks an old-format all-off save."""
    mentioned: set[str] = set()
    grants: set[tuple[str, str]] = set()
    legacy_all_off = False
    for r in store_rules:
        resource, action = r[2], r[3]
        if resource == _OVERRIDE_SENTINEL:
            legacy_all_off = True
            continue
        mentioned.add(resource)
        if action != _RESOURCE_NONE:
            grants.add((resource, action))
    return mentioned, grants, legacy_all_off


def _resolve_grants(role: str, store_id: int) -> set[tuple[str, str]]:
    """Effective (resource, action) grants for a role at a store.

    Store overrides are a PER-RESOURCE overlay, not a wholesale
    replacement: rows govern only the resources they mention (a
    ``__none__`` marker mentions a resource with all actions off);
    resources the override never mentions fall back to the global
    defaults. This is what lets a NEW platform resource (lottery,
    day_close, catalog…) reach stores whose override matrix was
    saved before the resource existed — the old wholesale
    semantics froze those stores out of every later resource.

    Legacy compatibility: a pre-overlay all-off save is a lone
    ``__override_active__`` sentinel → still means zero access.
    A pre-overlay partial save has no markers, so its switched-off
    resources fall back to global once; the next save re-freezes
    them explicitly.
    """
    e = _get_enforcer()
    store_rules = e.get_filtered_policy(0, role, str(store_id))
    if not store_rules:
        return _global_grants(role)
    mentioned, grants, legacy_all_off = _store_overlay(store_rules)
    if legacy_all_off and not mentioned:
        return set()
    return _with_implied_read(grants) | {
        (resource, action)
        for resource, action in _global_grants(role)
        if resource not in mentioned
    }


# ── Per-user overlay (R-1) ─────────────────────────────────
#
# A third layer ABOVE the role layers: rows whose subject is
# ``user:<id>`` in the store's domain. Same per-resource overlay
# semantics as the store layer — user rows govern only the
# resources they mention (a ``__none__`` marker mentions a
# resource with zero grants); unmentioned resources fall back to
# the role's resolved grants. This is what makes "Amber gets
# time clock + transfers but can't see any numbers" expressible
# without forking the role system, and it is a SECURITY boundary
# (unlike ``User.module_access``, which is nav-only UX gating).


def _user_subject(user_id: int) -> str:
    return f"user:{int(user_id)}"


def _user_overlay(
    user_id: int, store_id: int,
) -> tuple[set[str], set[tuple[str, str]]]:
    """(mentioned resources, grants) from the user's own rows."""
    e = _get_enforcer()
    rules = e.get_filtered_policy(
        0, _user_subject(user_id), str(store_id),
    )
    mentioned: set[str] = set()
    grants: set[tuple[str, str]] = set()
    for r in rules:
        resource, action = r[2], r[3]
        mentioned.add(resource)
        if action != _RESOURCE_NONE:
            grants.add((resource, action))
    return mentioned, grants


def resolve_user_grants(
    user_id: int, role: str, store_id: int,
) -> set[tuple[str, str]]:
    """Effective grants for one USER at a store: the user's own
    overlay where it speaks, the role's resolved grants where it
    doesn't."""
    mentioned, grants = _user_overlay(user_id, store_id)
    role_grants = _resolve_grants(role, store_id)
    if not mentioned:
        return role_grants
    return _with_implied_read(grants) | {
        (resource, action)
        for resource, action in role_grants
        if resource not in mentioned
    }


def user_has_custom_permissions(user_id: int, store_id: int) -> bool:
    """True when the user carries any overlay rows at this store."""
    try:
        e = _get_enforcer()
        return bool(e.get_filtered_policy(
            0, _user_subject(user_id), str(store_id),
        ))
    except Exception:
        return False


# ── Public read API ────────────────────────────────────────

def resolve_grants(
    role: str, store_id: int | None = None, user_id: int | None = None,
) -> set[tuple[str, str]]:
    """THE resolver. Every permission question goes through here.

    * superadmin → everything;
    * no store scope (an owner's umbrella token) → the global rows
      for the role, so a superadmin edit to the owner row applies
      to owners wherever they are;
    * a store scope → the store overlay over the global rows, and
      the user's own overlay on top when ``user_id`` is given.

    Raises when the policy cannot be read; the public wrappers
    decide what that means for their caller.
    """
    if role == "superadmin":
        return {(r, a) for r in RBAC_RESOURCES for a in RBAC_ACTIONS}
    if role not in RBAC_DEFAULTS:
        # Unknown or blank role: nothing. (A blank subject would
        # also match EVERY row in a filtered policy lookup.)
        return set()
    if store_id is None:
        return _global_grants(role)
    if user_id is not None:
        return resolve_user_grants(int(user_id), role, store_id)
    return _resolve_grants(role, store_id)


def _grants_on_fault(role: str, where: str, exc: Exception) -> set[tuple[str, str]]:
    """What a permission question answers when the policy cannot
    be read. Only a process that has NEVER loaded a policy (the
    database was unreachable since boot) falls back to the
    hardcoded defaults so the platform is not dead on arrival.
    Once a policy was loaded, ``_get_enforcer`` keeps serving the
    last good copy through a failed reload, so an exception here
    means something is genuinely wrong — and the safe answer for a
    permission system is NO, not "whatever the role usually
    gets": the defaults would hand a restricted admin the whole
    store."""
    if _enforcer is None:
        _log.warning(
            "%s: no policy has ever been loaded (role=%s); answering "
            "from RBAC_DEFAULTS. Error: %s", where, role, exc,
        )
        return _default_grants(role)
    _log.error(
        "%s: policy lookup failed for role=%s; denying. Error: %s",
        where, role, exc, exc_info=True,
    )
    return set()


def check_permission(
    role: str, store_id: int | None,
    resource: str, action: str,
    user_id: int | None = None,
) -> bool:
    """Live permission check. Superadmin always passes.

    ``user_id`` (when provided with a store scope) applies the
    per-user overlay above the role layers — callers that omit it
    get pure role resolution."""
    if role == "superadmin":
        return True
    try:
        grants = resolve_grants(role, store_id, user_id)
    except Exception as exc:  # noqa: BLE001 — see _grants_on_fault
        grants = _grants_on_fault(role, "check_permission", exc)
    return (resource, action) in grants


def permissions_for(
    role: str, store_id: int | None = None,
    user_id: int | None = None, **_kw: Any,
) -> list[str]:
    """Full permission list for a principal. Used for JWT claims.
    Accepts **kwargs for backward compat (old callers pass db=).

    ``user_id`` (with a store scope) bakes the per-user overlay
    into the list, so a restricted user's token never carries
    perms their overlay denies. Role-only callers are unchanged."""
    legacy = list(LEGACY_ROLE_PERMISSIONS.get(role, []))
    try:
        grants = resolve_grants(role, store_id, user_id)
    except Exception as exc:  # noqa: BLE001 — see _grants_on_fault
        grants = _grants_on_fault(role, "permissions_for", exc)
    return legacy + sorted(f"{r}.{a}" for r, a in grants)


# ── Write API ──────────────────────────────────────────────
#
# One writer. A matrix becomes the complete row set for ONE
# subject in ONE domain, and ``_replace_subject_rows`` swaps the
# old set for the new one inside a single database transaction:
# DELETE the subject's rows, INSERT the new ones, COMMIT. Nothing
# goes through the enforcer's ``add_policy`` / ``remove_*`` API,
# whose adapter autocommits every row (a reader on another worker
# could reload between the delete and the inserts and see NO
# override — a restricted admin becoming a full admin for a
# moment) and whose in-memory short-circuits let two writers
# leave a union of their rows behind.

# Legacy all-off marker (read-compat only — no longer written).
_OVERRIDE_SENTINEL = "__override_active__"
# Per-resource "mentioned with zero grants" marker. Every save
# writes one for each current resource with no allowed action, so
# the overlay knows "explicitly off" from "didn't exist yet".
_RESOURCE_NONE = "__none__"

Rows = list[tuple[str, str]]


def _rows_for_matrix(matrix: dict[str, dict[str, bool]]) -> Rows:
    """The complete row set a matrix stands for: a grant row per
    allowed action (read implied by any write), and a ``__none__``
    marker for every CURRENT resource with nothing allowed, so a
    resource added to the platform later is "not mentioned" and
    falls through to the layer below until the next save."""
    normalized = _normalized_matrix(matrix)
    rows: Rows = []
    for resource in RBAC_RESOURCES:
        actions = normalized.get(resource, {})
        allowed = [a for a in RBAC_ACTIONS if actions.get(a)]
        if allowed:
            rows.extend((resource, a) for a in allowed)
        else:
            rows.append((resource, _RESOURCE_NONE))
    return rows


_write_session_factory: sessionmaker[Session] | None = None


def _write_session() -> Session:
    global _write_session_factory
    if _write_session_factory is None:
        from api.Core.Database.session import _get_engine
        _write_session_factory = sessionmaker(
            bind=_get_engine(), autoflush=False, expire_on_commit=False,
        )
    return _write_session_factory()


def _lock_subject(session: Session, subject: str, domain: str) -> None:
    """Serialize writers for one (subject, domain) on Postgres so
    two saves of the same role cannot interleave their delete and
    insert statements. SQLite serializes writers on its own."""
    if session.get_bind().dialect.name != "postgresql":
        return
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
        {"key": f"casbin:{domain}:{subject}"},
    )


def _write_subject_rows(
    session: Session, domain: str, rows_by_subject: dict[str, Rows | None],
) -> None:
    """Replace each subject's rows in ``domain`` within the caller's
    transaction. ``None`` removes the subject's rows and writes
    nothing (reset / clear). Does not commit."""
    for subject in sorted(rows_by_subject):
        _lock_subject(session, subject, domain)
    for subject, rows in rows_by_subject.items():
        (
            session.query(CasbinRule)
            .filter(
                CasbinRule.ptype == "p",
                CasbinRule.v0 == subject,
                CasbinRule.v1 == domain,
            )
            .delete(synchronize_session=False)
        )
        for resource, action in rows or []:
            session.add(CasbinRule(
                ptype="p", v0=subject, v1=domain, v2=resource, v3=action,
            ))
    session.flush()


def _replace_subject_rows(
    domain: str, rows_by_subject: dict[str, Rows | None],
    *, session: Session | None = None,
) -> None:
    """Swap the row sets for one or more subjects in ``domain``.

    Without ``session``: one transaction of its own, committed here,
    and this worker reloads its policy before returning. With
    ``session``: the rows join the caller's transaction (commit
    together with the audit entry, the role rows, the revoked
    sessions…) and this worker reloads right after that commit —
    a once-only ``after_commit`` hook on the session does it, so
    no caller has to remember to.
    """
    if session is not None:
        _write_subject_rows(session, domain, rows_by_subject)
        event.listen(
            session, "after_commit", _reload_after_commit, once=True,
        )
        return
    own = _write_session()
    try:
        _write_subject_rows(own, domain, rows_by_subject)
        own.commit()
    except Exception:
        own.rollback()
        raise
    finally:
        own.close()
    reload_policy()


def _reload_after_commit(_session: Session) -> None:
    try:
        reload_policy()
    except Exception:  # noqa: BLE001 — the periodic reload catches up
        _log.warning("Casbin: reload after commit failed", exc_info=True)


def set_store_permissions(
    store_id: int, role: str,
    matrix: dict[str, dict[str, bool]],
    *, session: Session | None = None,
) -> None:
    """Replace the per-store overlay for a role. Every CURRENT
    resource is written explicitly — grants, or a ``__none__``
    marker when all its actions are off — so resources added to
    the platform later fall back to global defaults until the
    matrix is saved again (see ``_resolve_grants``)."""
    _replace_subject_rows(
        str(store_id), {role: _rows_for_matrix(matrix)}, session=session,
    )


def set_global_permissions(
    role: str,
    matrix: dict[str, dict[str, bool]],
    *, session: Session | None = None,
) -> None:
    """Replace the global defaults for a role. Same explicit-write
    contract as the store layer: a resource with nothing allowed
    gets a ``__none__`` marker, so "the superadmin turned it off
    for everyone" is stored as such and does not read back as
    "never configured" (which would resurrect the hardcoded
    defaults — all-off used to restore everything)."""
    _replace_subject_rows(
        "global", {role: _rows_for_matrix(matrix)}, session=session,
    )


def reset_store_to_defaults(
    store_id: int, role: str, *, session: Session | None = None,
) -> None:
    """Remove per-store overrides for a role."""
    _replace_subject_rows(str(store_id), {role: None}, session=session)


def set_user_permissions(
    store_id: int, user_id: int,
    matrix: dict[str, dict[str, bool]],
    *, session: Session | None = None,
) -> None:
    """Replace the per-USER overlay at a store. Same explicit-write
    contract as ``set_store_permissions``. This is a SECURITY
    write — callers must audit it and revoke the user's live
    sessions so old JWT perms die."""
    set_user_permissions_bulk(store_id, {user_id: matrix}, session=session)


def set_user_permissions_bulk(
    store_id: int, matrices: dict[int, dict[str, dict[str, bool]]],
    *, session: Session | None = None,
) -> None:
    """Replace several users' overlays at a store in ONE
    transaction — a saved role pushing its matrix onto every
    member either lands for all of them or for none."""
    if not matrices:
        return
    _replace_subject_rows(
        str(store_id),
        {
            _user_subject(uid): _rows_for_matrix(matrix)
            for uid, matrix in matrices.items()
        },
        session=session,
    )


def clear_user_permissions(
    store_id: int, user_id: int, *, session: Session | None = None,
) -> None:
    """Remove the per-user overlay — the user goes back to pure
    role resolution. Also a session-revoking security write."""
    _replace_subject_rows(
        str(store_id), {_user_subject(user_id): None}, session=session,
    )


def purge_store_rows(store_id: int, *, session: Session | None = None) -> None:
    """Drop every row in a store's domain (role overrides and user
    overlays alike) — the data-retention purge."""
    def _run(s: Session) -> None:
        (
            s.query(CasbinRule)
            .filter(CasbinRule.ptype == "p", CasbinRule.v1 == str(store_id))
            .delete(synchronize_session=False)
        )
        s.flush()
    if session is not None:
        _run(session)
        event.listen(session, "after_commit", _reload_after_commit, once=True)
        return
    own = _write_session()
    try:
        _run(own)
        own.commit()
    finally:
        own.close()
    reload_policy()


def get_user_permission_matrix(
    user_id: int, role: str, store_id: int,
) -> dict:
    """Resolved effective matrix for one user (overlay applied over
    the role layers) plus whether an overlay exists — feeds the
    per-user access editor in the admin user form."""
    granted = resolve_user_grants(user_id, role, store_id)
    matrix: dict[str, dict[str, bool]] = {}
    for resource in RBAC_RESOURCES:
        matrix[resource] = {
            action: (resource, action) in granted
            for action in RBAC_ACTIONS
        }
    return {
        "user_id": user_id,
        "role": role,
        "store_id": store_id,
        "resources": RBAC_RESOURCES,
        "actions": RBAC_ACTIONS,
        "matrix": matrix,
        "has_custom": user_has_custom_permissions(user_id, store_id),
    }


def seed_defaults() -> None:
    """Seed global defaults if Casbin is empty. Idempotent."""
    e = _enforcer_for_write()
    if e.get_policy():
        return
    rows_by_role: dict[str, Rows | None] = {
        role: [tuple(perm.split(".", 1)) for perm in perms]  # type: ignore[misc]
        for role, perms in RBAC_DEFAULTS.items()
    }
    _replace_subject_rows("global", rows_by_role)
    _log.info("Casbin: seeded %d default rules",
              sum(len(v) for v in RBAC_DEFAULTS.values()))


def ensure_resource_defaults(resource: str) -> int:
    """Additively seed the default rules for ONE resource into an
    ALREADY-SEEDED policy store — the path a brand-new resource
    (e.g. "lottery") takes on existing databases, where
    ``seed_defaults`` is a no-op because policy is non-empty.

    A role whose global rows already MENTION the resource (a
    grant, or a ``__none__`` marker left by a superadmin who
    turned it off) is left alone: the superadmin's decision wins
    over the shipped default, on this boot and every later one.
    Returns the number of rows added. ``api.Core.Boot`` runs this
    once per resource and records that it did."""
    e = _enforcer_for_write()
    if not e.get_policy():
        return 0  # empty store → seed_defaults handles the full set
    added = 0
    for role, perms in RBAC_DEFAULTS.items():
        wanted = [
            tuple(perm.split(".", 1)) for perm in perms
            if perm.split(".", 1)[0] == resource
        ]
        if not wanted:
            continue
        current = e.get_filtered_policy(0, role, "global")
        if any(r[2] == resource for r in current):
            continue  # mentioned: the stored decision stands
        rows: Rows = [(r[2], r[3]) for r in current]
        rows.extend(wanted)  # type: ignore[arg-type]
        _replace_subject_rows("global", {role: rows})
        added += len(wanted)
    if added:
        _log.info(
            "Casbin: additively seeded %d default rules for new "
            "resource %r", added, resource,
        )
    return added


# ── Matrix builders (for permission UI endpoints) ──────────

def get_permission_matrix(
    store_id: int,
    visible_roles: list[str] | None = None,
    editable_roles: list[str] | None = None,
) -> dict:
    """Build the permission matrix for the store permissions UI."""
    if visible_roles is None:
        visible_roles = ["admin", "employee"]
    if editable_roles is None:
        editable_roles = visible_roles

    matrix: dict[str, dict[str, dict[str, bool]]] = {}
    has_overrides: list[str] = []
    e = _get_enforcer()

    for role in visible_roles:
        dom = str(store_id)
        store_rules = e.get_filtered_policy(0, role, dom)
        if store_rules:
            has_overrides.append(role)
            # Same per-resource overlay as _resolve_grants, so the
            # UI shows the grants that are actually enforced.
            granted = _resolve_grants(role, store_id)
        else:
            granted = _global_grants(role)

        matrix[role] = {}
        for resource in RBAC_RESOURCES:
            matrix[role][resource] = {}
            for action in RBAC_ACTIONS:
                matrix[role][resource][action] = (resource, action) in granted

    return {
        "store_id": store_id,
        "roles": visible_roles,
        "editable_roles": editable_roles,
        "resources": RBAC_RESOURCES,
        "actions": RBAC_ACTIONS,
        "matrix": matrix,
        "has_overrides": has_overrides,
    }


def get_global_matrix() -> dict:
    """Build the global permission matrix for superadmin UI."""
    e = _get_enforcer()
    granted: set[tuple[str, str, str]] = set()
    for r in e.get_policy():
        if r[1] == "global":
            granted.add((r[0], r[2], r[3]))
    if not granted:
        for role, perms in RBAC_DEFAULTS.items():
            for perm in perms:
                res, act = perm.split(".", 1)
                granted.add((role, res, act))

    roles = ["admin", "employee", "owner"]
    matrix: dict[str, dict[str, dict[str, bool]]] = {}
    for role in roles:
        matrix[role] = {}
        for resource in RBAC_RESOURCES:
            matrix[role][resource] = {}
            for action in RBAC_ACTIONS:
                matrix[role][resource][action] = (
                    (role, resource, action) in granted
                    # Same implied read as _with_implied_read.
                    or (action == "read" and any(
                        (role, resource, a) in granted for a in RBAC_ACTIONS
                    ))
                )

    return {
        "roles": roles,
        "resources": RBAC_RESOURCES,
        "actions": RBAC_ACTIONS,
        "matrix": matrix,
    }
