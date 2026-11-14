"""Feature-flag + add-on resolution.

Two related helpers, both pure reads:
  store_feature_enabled — per-store override → global default →
                          fail-open (undeclared flag = True).
  store_has_addon       — predicate over the comma-separated
                          Store.addons string.

Per CLAUDE.md invariant #6: undeclared flags fail open. Don't
change that without a coordinated plan — there are gated routes
that depend on it for forward-compat with new flag keys.
"""
from sqlalchemy.orm import Session

from api.Modules.Billing.Models import (
    FeatureFlag,
    Store,
    StoreFeatureOverride,
)
from api.Modules.Billing.Services.store_state import store_addon_keys


# ── Business-type module bundles (the pivot, HANDOFF.md §2) ────────
#
# ``module_*`` flags gate whole PRODUCT MODULES per business type —
# a convenience store shouldn't see the money-transfer ledger it
# never uses, while the original MSB profile keeps everything. The
# resolution order in ``store_feature_enabled`` slots the bundle
# BETWEEN the per-store override and the global default, so:
#   • superadmin can still flip any module per store (override wins),
#   • non-module flags behave exactly as before,
#   • an unknown business_type falls through to the old behavior
#     (fail-open — same spirit as CLAUDE.md invariant #6).
#
# NOTE: module flags are a product/UX boundary, not a security
# boundary — routes stay store-scoped regardless. When modules
# become billing-tiered, add backend enforcement at that point.
MODULE_FLAG_KEYS = (
    "module_money_services", "module_lottery", "module_day_close",
    "module_check_cashing", "module_price_book",
)

# Opt-in flags that show a sidebar group, sent to the SPA beside the
# module flags (``features`` on /auth/session-status) so its nav can
# hide the group. Resolved with ``opt_in_flag_enabled`` (never fails
# open) and not part of a person's ``module_access`` list.
OPT_IN_NAV_FLAG_KEYS = ("check_desk",)
# Sent to an owner: the check cashing report link (any device, no store needed).
OWNER_CHECK_REPORT_FLAG = "check_desk_report"

_BUSINESS_TYPE_MODULE_DEFAULTS: dict[str, dict[str, bool]] = {
    # module_money_services: money-transfer ledger + ACH batches +
    # sender directory. Check cashing / returned checks are NOT in
    # this bundle — plenty of c-stores cash checks, so those
    # surfaces stay available to every type.
    # module_lottery: games / packs / day-close counts. ON for the
    # retail types that sell scratch-offs; OFF for the pure
    # money-services profile (override available per store).
    # module_day_close: register/shift Z-report totals + department
    # sales (P1-7). ON for the retail types; OFF for msb_hybrid,
    # whose day-close is the daily book itself.
    # module_check_cashing: returned-checks pages + the check-
    # cashing / hold-fee entries in the daily book (P1-11). ON for
    # EVERY type — plenty of c-stores cash checks — with the
    # per-store override as the off switch for stores that don't.
    # module_price_book: item catalog + vendors (P2-1). ON for the
    # retail types (shelves full of scannable items); OFF for the
    # pure money-services profile, which has no shelf inventory.
    "cstore": {
        "module_money_services": False,
        "module_lottery": True,
        "module_day_close": True,
        "module_check_cashing": True,
        "module_price_book": True,
    },
    "gas_station": {
        "module_money_services": False,
        "module_lottery": True,
        "module_day_close": True,
        "module_check_cashing": True,
        "module_price_book": True,
    },
    "grocery": {
        "module_money_services": False,
        "module_lottery": True,
        "module_day_close": True,
        "module_check_cashing": True,
        "module_price_book": True,
    },
    "msb_hybrid": {
        "module_money_services": True,
        "module_lottery": False,
        "module_day_close": False,
        "module_check_cashing": True,
        "module_price_book": False,
    },
}


def module_bundle_default(
    business_type: str | None, flag_key: str,
) -> bool | None:
    """The business-type bundle's answer for a module flag, or None
    when the bundle has no opinion (non-module flag, or unknown
    type)."""
    if business_type is None:
        return None
    return _BUSINESS_TYPE_MODULE_DEFAULTS.get(business_type, {}).get(flag_key)


def store_feature_enabled(
    db: Session, store: Store | None, flag_key: str,
) -> bool:
    """Resolve a feature flag for a store.

    Lookup priority:
      1. per-store override (StoreFeatureOverride row) — if present,
         that value wins regardless of the global default.
      2. business-type module bundle (``module_*`` flags only) —
         which modules this kind of business gets by default.
      3. global default (FeatureFlag.enabled_by_default).
      4. fail-open: undeclared flag → True (CLAUDE.md invariant #6).

    Reads the same DB the legacy helper does; the only difference is
    the explicit `db` parameter so the Service can be exercised from
    any caller (FastAPI, CLI, tests).
    """
    if store is not None:
        override = (
            db.query(StoreFeatureOverride)
              .filter_by(store_id=store.id, flag_key=flag_key)
              .first()
        )
        if override is not None:
            return bool(override.enabled)
        bundled = module_bundle_default(
            getattr(store, "business_type", None), flag_key,
        )
        if bundled is not None:
            return bundled
    flag = db.query(FeatureFlag).filter_by(key=flag_key).first()
    if flag is None:
        # Unknown flag = allow by default (fail-open for undeclared
        # features). See CLAUDE.md invariant #6.
        return True
    return bool(flag.enabled_by_default)


def stores_feature_enabled(
    db: Session, stores: list[Store], flag_key: str,
) -> dict[int, bool]:
    """``store_feature_enabled`` for many stores at once, as
    ``{store_id: enabled}`` — two queries however many stores, for
    platform lists. Same priority: override → business-type bundle →
    global default → fail-open."""
    if not stores:
        return {}
    overrides = {
        int(row.store_id): bool(row.enabled)
        for row in db.query(StoreFeatureOverride).filter(
            StoreFeatureOverride.flag_key == flag_key,
            StoreFeatureOverride.store_id.in_([s.id for s in stores]),
        )
    }
    flag = db.query(FeatureFlag).filter_by(key=flag_key).first()
    fallback = True if flag is None else bool(flag.enabled_by_default)
    out: dict[int, bool] = {}
    for store in stores:
        sid = int(store.id)
        if sid in overrides:
            out[sid] = overrides[sid]
            continue
        bundled = module_bundle_default(
            getattr(store, "business_type", None), flag_key,
        )
        out[sid] = fallback if bundled is None else bundled
    return out


def opt_in_flag_enabled(db: Session, store_id: int, flag_key: str) -> bool:
    """Resolve an OPT-IN flag: a switch for new behaviour that must
    stay off until someone turns it on (the owner's store first,
    every store once it has proven itself).

    Lookup: per-store override → the registry row's default → the
    default declared in ``DEFAULT_FEATURE_FLAGS`` → off. Unlike
    ``store_feature_enabled`` it never fails open: a database with no
    registry row yet (a test database, a boot before the seed) reads
    the declared default, so nothing changes for a store until it is
    switched on. Used by ``bank_matching`` and ``notification_bell``.
    """
    override = (
        db.query(StoreFeatureOverride)
          .filter_by(store_id=store_id, flag_key=flag_key)
          .first()
    )
    if override is not None:
        return bool(override.enabled)
    flag = db.query(FeatureFlag).filter_by(key=flag_key).first()
    if flag is not None:
        return bool(flag.enabled_by_default)
    from api.Core.Bootstrap import DEFAULT_FEATURE_FLAGS
    for key, _label, _desc, default in DEFAULT_FEATURE_FLAGS:
        if key == flag_key:
            return bool(default)
    return False


def enabled_module_flags(db: Session, store: Store | None) -> list[str]:
    """The module flags currently ON for this store — the SPA reads
    this off /auth/session-status to decide which nav sections and
    routes to show. ``store=None`` (superadmin / owner without store
    scope) enables everything: platform operators see all modules."""
    if store is None:
        return list(MODULE_FLAG_KEYS)
    return [
        key for key in MODULE_FLAG_KEYS
        if store_feature_enabled(db, store, key)
    ] + [
        key for key in OPT_IN_NAV_FLAG_KEYS
        if opt_in_flag_enabled(db, int(store.id), key)
    ]


def enabled_module_flags_for_user(
    db: Session, store: Store | None, user: object | None,
) -> list[str]:
    """Store module flags intersected with the user's per-user
    ``module_access`` grants (U-3). NULL module_access = every
    module the store has; a CSV subset restricts what shows in the
    nav/session. Only admin/employee are restricted — owner and
    superadmin sessions always get the store's full set. UX gating
    only: routes stay permission-gated via Casbin.

    ``user`` is duck-typed (needs ``role`` + ``module_access``) so
    this module doesn't grow a Tenancy import.
    """
    store_flags = enabled_module_flags(db, store)
    if getattr(user, "role", None) == "owner":
        # An owner gets the view-only check cashing report in their
        # Reports menu once any of their stores has check cashing on
        # (signed in without a store, too: the desk needs a store, the
        # report does not).
        from api.Modules.Owners.Services import owner_store_ids
        if any(
            opt_in_flag_enabled(db, int(sid), "check_desk")
            for sid in owner_store_ids(db, user)
        ):
            store_flags = [*store_flags, OWNER_CHECK_REPORT_FLAG]
    if user is None or getattr(user, "role", None) not in ("admin", "employee"):
        return store_flags
    raw = getattr(user, "module_access", None)
    if raw is None:
        return store_flags
    allowed = {key.strip() for key in str(raw).split(",") if key.strip()}
    # Opt-in pages are not per-user modules: a person's module list
    # predates them, so it must not hide them; the permission gate
    # still decides who sees them.
    allowed.update(OPT_IN_NAV_FLAG_KEYS)
    return [key for key in store_flags if key in allowed]


def store_has_addon(store: Store | None, addon_key: str) -> bool:
    """Single predicate every add-on-gated route uses.

    Reads the comma-separated `Store.addons` field; doesn't touch
    the DB. Future `customer.subscription.updated` syncs that flip
    add-ons via the same field automatically propagate to every
    gated surface.
    """
    return addon_key in store_addon_keys(store)
