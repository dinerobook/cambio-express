"""What a permission question answers when the policy cannot be read.

Two cases, and they answer differently on purpose:

* A process that has NEVER loaded a policy (the database was
  unreachable since boot) falls back to ``RBAC_DEFAULTS`` so the
  platform is not dead on arrival.
* A process that HAS a policy keeps serving its last good copy
  through a failed reload (``_get_enforcer``), so an exception out
  of a lookup means something is genuinely wrong — and the answer
  is NO. The old behaviour (audit of 2026-10-08, finding 10) was
  to hand back the role's defaults, which gave a restricted admin
  the whole store for the duration of a fault.

Superadmin never consults the policy at all.
"""
from unittest.mock import patch


def test_lookup_failure_with_a_loaded_policy_denies():
    from api.Core.Permissions import (
        LEGACY_ROLE_PERMISSIONS, _get_enforcer, check_permission,
        permissions_for,
    )
    _get_enforcer()  # a policy is loaded in this process
    with patch(
        "api.Core.Permissions._resolve_grants",
        side_effect=ConnectionError("db unreachable"),
    ):
        assert check_permission("admin", 1, "transfers", "read") is False
        assert check_permission("employee", 1, "transfers", "read") is False
        assert permissions_for("admin", store_id=1) == list(
            LEGACY_ROLE_PERMISSIONS["admin"],
        )


def test_no_policy_ever_loaded_answers_from_defaults(monkeypatch):
    import api.Core.Permissions as P
    from api.Core.Permissions import (
        LEGACY_ROLE_PERMISSIONS, RBAC_DEFAULTS, check_permission,
        permissions_for,
    )
    monkeypatch.setattr(P, "_enforcer", None)
    monkeypatch.setattr(
        P, "_build_enforcer",
        lambda: (_ for _ in ()).throw(ConnectionError("db down at boot")),
    )
    assert check_permission("admin", 1, "transfers", "read") is True
    assert check_permission("admin", 1, "fake", "delete") is False
    assert check_permission("employee", 1, "transfers", "delete") is False
    assert check_permission("employee", 1, "settings", "update") is False
    perms = permissions_for("employee", store_id=1)
    for p in RBAC_DEFAULTS["employee"]:
        assert p in perms
    for legacy in LEGACY_ROLE_PERMISSIONS["employee"]:
        assert legacy in perms


def test_failed_reload_keeps_the_last_good_policy(monkeypatch):
    """A DB blip during the periodic reload is not a lookup failure:
    the previous copy keeps answering, and it answers correctly."""
    import api.Core.Permissions as P
    from api.Core.Permissions import check_permission
    P.reload_policy()
    monkeypatch.setattr(P, "_RELOAD_INTERVAL", 0.0)
    monkeypatch.setattr(
        P._enforcer, "load_policy",
        lambda *a, **k: (_ for _ in ()).throw(ConnectionError("blip")),
    )
    assert check_permission("admin", 1, "transfers", "read") is True
    assert check_permission("employee", 1, "settings", "update") is False


def test_superadmin_bypass_skips_resolve_grants():
    from api.Core.Permissions import check_permission, permissions_for
    with patch(
        "api.Core.Permissions._resolve_grants",
        side_effect=RuntimeError("should not be called"),
    ) as mock:
        perms = permissions_for("superadmin")
        assert "transfers.read" in perms
        assert check_permission("superadmin", 1, "anything", "delete") is True
        mock.assert_not_called()


def test_the_overlay_blind_require_permission_is_gone():
    """``api.Core.Permissions.require_permission`` ignored per-user
    overlays and shadowed the real one in Auth/Services/principal;
    nothing may import it again."""
    import api.Core.Permissions as P
    assert not hasattr(P, "require_permission")
