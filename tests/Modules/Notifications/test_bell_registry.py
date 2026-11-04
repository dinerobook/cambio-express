"""The bell's contracts — what keeps a future item from breaking it.

  * every source is one known kind, declared once, with at least one
    permission that really exists in the RBAC registry, and only a
    module / feature flag that is declared;
  * every kind the server can send has a source AND a row in the
    SPA's item table (``frontend/src/lib/bellItems.ts``);
  * the migration spells out exactly the model's columns and imports
    no application code;
  * the dismissal table is in the store purge list.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

from api.Core.Bootstrap import DEFAULT_FEATURE_FLAGS
from api.Core.Permissions import RBAC_RESOURCES, actions_for
from api.Modules.Notifications.Models import BellDismissal
from api.Modules.Notifications.Services import bell

ROOT = Path(__file__).resolve().parents[3]
SPA_TABLE = ROOT / "frontend" / "src" / "lib" / "bellItems.ts"
MIGRATION = ROOT / "alembic" / "versions" / "c9d4e7a2f1b6_add_notify_bell_dismissal.py"
DECLARED_FLAGS = {f[0] for f in DEFAULT_FEATURE_FLAGS}


def test_every_kind_has_exactly_one_source():
    kinds = [s.kind for s in bell.SOURCES]
    assert len(kinds) == len(set(kinds)), "a kind is registered twice"
    assert sorted(kinds) == sorted(bell.ALL_KINDS)


def test_every_source_needs_a_real_permission():
    for source in bell.SOURCES:
        assert source.permissions, f"{source.kind} declares no permission"
        for perm in source.permissions:
            resource, _, action = perm.partition(".")
            assert resource in RBAC_RESOURCES, f"{source.kind}: {perm}"
            assert action in actions_for(resource), f"{source.kind}: {perm}"


def test_modules_and_features_are_declared_flags():
    assert bell.FEATURE_FLAG in DECLARED_FLAGS
    for source in bell.SOURCES:
        for flag in (source.module, source.feature):
            if flag is not None:
                assert flag in DECLARED_FLAGS, f"{source.kind}: {flag}"
        if source.module is not None:
            assert source.module.startswith("module_")


def test_every_kind_has_a_row_in_the_spa_item_table():
    text = SPA_TABLE.read_text()
    rows = set(re.findall(r'^\s*"([a-z_]+\.[a-z_]+)":\s*\{', text, re.M))
    assert rows == set(bell.ALL_KINDS), (
        "frontend/src/lib/bellItems.ts and BellKind disagree"
    )


def test_sources_never_write():
    """A source only reads. A cheap tripwire over the source files:
    no session writes, no email, no push, no Stripe."""
    banned = (".add(", ".commit(", ".delete(", ".merge(", "send_email",
              "push", "stripe", "enqueue(")
    for path in (ROOT / "api/Modules/Notifications/Services/bell/sources").glob("*.py"):
        body = path.read_text().lower()
        for word in banned:
            assert word not in body, f"{path.name} uses {word}"


def _migration():
    spec = importlib.util.spec_from_file_location("bell_migration", MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_matches_the_model():
    m = _migration()
    assert m.TABLE == BellDismissal.__tablename__
    assert tuple(m.COLUMNS) == tuple(c.name for c in BellDismissal.__table__.columns)
    assert m.INDEX in {i.name for i in BellDismissal.__table__.indexes}


def test_migration_does_not_import_application_code():
    for line in MIGRATION.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped


def test_user_id_is_not_a_foreign_key():
    """An owner dismisses in a store their user row is not pinned to,
    and deleting an employee must never be blocked by a reminder."""
    assert not BellDismissal.__table__.c.user_id.foreign_keys


def test_dismissals_are_purged_with_the_store():
    from api.Modules.Billing.Services.retention import (
        STORE_OWNED_MODELS, _store_owned_models,
    )
    assert "BellDismissal" in STORE_OWNED_MODELS
    assert (BellDismissal, "store_id") in _store_owned_models()


def test_migration_runs_up_and_down_twice(tmp_path, monkeypatch):
    """Idempotent both ways on a real (SQLite) database built from
    the revision before it."""
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect

    url = f"sqlite:///{tmp_path / 'bell.db'}"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "b8e4f2a6c1d3")
    command.upgrade(cfg, "c9d4e7a2f1b6")
    engine = create_engine(url)
    assert "notify_bell_dismissal" in inspect(engine).get_table_names()
    command.downgrade(cfg, "b8e4f2a6c1d3")
    assert "notify_bell_dismissal" not in inspect(create_engine(url)).get_table_names()
    command.upgrade(cfg, "head")
    assert "notify_bell_dismissal" in inspect(create_engine(url)).get_table_names()
