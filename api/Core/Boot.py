"""Boot-time initialisation for production + tests.

Single source of truth for "what needs to happen before the first
HTTP request is served": Alembic upgrade, index safety-net,
legacy backfills, seed data. Replaces ``api/Flask/Init.py``'s
``init_db()`` orchestrator, which was bound to the Flask app
context. This module takes the shared engine + ``SessionLocal``
from ``api.Core.Database`` directly — no Flask required.

Called from two places:

* ``api.main.create_app()``'s lifespan hook — production. Runs
  once at uvicorn startup, before the first request lands.
* ``tests/conftest.py`` — runs once at test-session start, then
  again before every test via the ``clean_db`` fixture (which
  drops + recreates the schema, then re-seeds).

Idempotent — safe on every boot.
"""
from __future__ import annotations

import logging
import os
from typing import Optional, cast

from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session


def warn_default_seed_passwords(
    logger: Optional[logging.Logger] = None,
) -> None:
    """Loud structured-log warning when prod boots with the default
    seed passwords (super2025! / cambio2025!) still in effect."""
    if not os.environ.get("APP_BASE_URL", "").startswith("https://"):
        return
    log = logger or logging.getLogger("dinerobook")
    missing = []
    if not os.environ.get("SUPERADMIN_PASSWORD"):
        missing.append("SUPERADMIN_PASSWORD")
    if not os.environ.get("ADMIN_PASSWORD"):
        missing.append("ADMIN_PASSWORD")
    if missing:
        log.critical(
            "Seed password fallback is active in prod for: "
            "%s. The default values (super2025! / cambio2025!) "
            "are public in the repo. Either set the env vars OR "
            "change the password in the UI immediately on first login.",
            ", ".join(missing),
        )


# Resources added AFTER the first Casbin seed. An existing database
# needs their default rows added once (``seed_defaults`` no-ops once
# policy exists). Append new resources here when they join
# ``RBAC_RESOURCES``.
LATER_RESOURCES: tuple[str, ...] = ("lottery", "day_close", "catalog")

_SEED_MARKER = "casbin_seeded:{resource}"


def seed_new_resources(
    session: "Session", log: logging.Logger | None = None,
) -> list[str]:
    """Seed each later resource's defaults ONCE per database.

    The additive seed used to run on every boot, so a global row
    the superadmin had turned off came back with the next deploy
    (the 2026-10-08 audit, finding 3). Now a ``platform_setting``
    marker records that a resource was seeded, and a seeded
    resource is never touched again — whatever the superadmin
    decides afterwards stands. (``ensure_resource_defaults``
    itself also skips a role whose global rows already mention
    the resource, so even a stray call cannot undo an explicit
    off.) Returns the resources seeded on this call.
    """
    from api.Core.Permissions import ensure_resource_defaults
    from api.Modules.Superadmin.Models import get_setting, set_setting
    seeded: list[str] = []
    for resource in LATER_RESOURCES:
        key = _SEED_MARKER.format(resource=resource)
        if get_setting(session, key) == "1":
            continue
        ensure_resource_defaults(resource)
        set_setting(session, key, "1")
        seeded.append(resource)
    if seeded and log is not None:
        log.info("Casbin: seeded defaults for new resources %s", seeded)
    return seeded


def init_db(logger: Optional[logging.Logger] = None) -> None:
    """Run the boot-time DB initialisation.

    Schema upgrade + indexes + legacy backfills + feature-flag seed +
    TV catalog seed + superadmin seed. Idempotent — re-running on an
    already-initialised DB is a no-op.
    """
    log = logger or logging.getLogger("dinerobook")
    warn_default_seed_passwords(log)

    from api.Core.Bootstrap import (
        apply_schema, drop_legacy_tables, ensure_added_indexes,
        migrate_legacy_line_item_tables, rename_maxi_transfer_to_maxi,
        seed_feature_flags,
    )
    from api.Core.Database import SessionLocal, engine
    from api.Modules.Tenancy.Models import User

    # ``engine`` is a lazy proxy that resolves to the real
    # SQLAlchemy ``Engine`` on first attribute access — cast at
    # the boundary so mypy sees the Engine type expected by the
    # bootstrap helpers.
    apply_schema(cast(Engine, engine), log)
    ensure_added_indexes(cast(Engine, engine), log)
    drop_legacy_tables(cast(Engine, engine), log)

    with SessionLocal() as session:
        rename_maxi_transfer_to_maxi(session, log)
        try:
            migrate_legacy_line_item_tables(session)
        except Exception as e:
            log.warning(f"Legacy line-item migration skipped: {e}")
        seed_feature_flags(session)

        try:
            from api.Modules.TVDisplay.Services.seed import run as seed_tv
            # The legacy ``app.root_path`` argument is the repo root —
            # one level up from ``api/``.
            import os.path
            repo_root = os.path.dirname(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            )
            n_imported = seed_tv(session, repo_root)
            if n_imported:
                log.info(
                    f"Imported {n_imported} TV logos from static/seed-logos/.",
                )
        except Exception as e:
            log.warning(f"TV catalog seed skipped: {e}")

        existing = (
            session.query(User)
            .filter_by(username="superadmin", store_id=None)
            .first()
        )
        if not existing:
            sa = User(
                username="superadmin", full_name="Platform Owner",
                role="superadmin", store_id=None,
            )
            sa.set_password(
                os.environ.get("SUPERADMIN_PASSWORD", "super2025!"),
            )
            session.add(sa)
            session.commit()
            if not os.environ.get("SUPERADMIN_PASSWORD"):
                log.warning(
                    "Seeded superadmin with default password. "
                    "Change immediately on first login or set "
                    "SUPERADMIN_PASSWORD env var.",
                )
            else:
                log.info("Seeded superadmin user (custom password set via env).")

        try:
            from api.Core.Permissions import seed_defaults as _seed_casbin
            _seed_casbin()
            seed_new_resources(session, log)
        except Exception as exc:
            log.warning("Casbin seed skipped: %s", exc)
