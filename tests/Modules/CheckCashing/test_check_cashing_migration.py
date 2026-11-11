"""The check cashing migrations spell out exactly the models' columns
and indexes, import no application code, and run up and down twice
(idempotent both ways).

  * d5e8a1c3f7b9 (PR 1): settings, customers, their IDs, companies;
  * e2a7c4f9b1d3 (PR 2): cashed checks, the activated computer, plus
    the settings' daily limit;
  * a3d9f2c6e8b1 (PR 3): pictures.
"""
import importlib.util
from pathlib import Path

import pytest

from api.Modules.CheckCashing.Models import (
    CashedCheck, CheckCashingSettings, CheckCompany, CheckCustomer,
    CheckCustomerId, CheckDevice, CheckPicture,
)

ROOT = Path(__file__).resolve().parents[3]
VERSIONS = ROOT / "alembic" / "versions"
PR1 = VERSIONS / "d5e8a1c3f7b9_add_check_cashing.py"
PR2 = VERSIONS / "e2a7c4f9b1d3_add_cashed_checks.py"
PR3 = VERSIONS / "a3d9f2c6e8b1_add_check_pictures.py"
MIGRATIONS = (PR1, PR2, PR3)
MODELS = (
    CheckCashingSettings, CheckCustomer, CheckCustomerId, CheckCompany,
    CashedCheck, CheckDevice, CheckPicture,
)
BEFORE = "c9d4e7a2f1b6"


def _load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migrations_match_the_models():
    """Every model column is created by exactly one migration: PR 1's
    table list plus the columns later migrations add, then PR 2's
    new tables."""
    pr1, pr2, pr3 = _load(PR1), _load(PR2), _load(PR3)
    columns: dict[str, list[str]] = {}
    for m in (pr1, pr2, pr3):
        for table, cols in m.TABLES.items():
            assert table not in columns, table
            columns[table] = list(cols)
    for table, cols in pr2.ADDED_COLUMNS.items():
        columns[table] += list(cols)
    assert set(columns) == {model.__tablename__ for model in MODELS}
    for model in MODELS:
        assert columns[model.__tablename__] == [
            c.name for c in model.__table__.columns
        ], model.__tablename__
    model_indexes = {
        i.name: (i.table.name, [c.name for c in i.columns])
        for model in MODELS for i in model.__table__.indexes
    }
    migration_indexes = {
        k: (t, list(c)) for m in (pr1, pr2, pr3)
        for k, (t, c) in {**m.INDEXES, **getattr(m, "UNIQUE_INDEXES", {})}.items()
    }
    assert migration_indexes == model_indexes


@pytest.mark.parametrize("path", MIGRATIONS, ids=lambda p: p.stem)
def test_migration_does_not_import_application_code(path):
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped


def test_migrations_run_up_and_down_twice(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect

    url = f"sqlite:///{tmp_path / 'cc.db'}"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    pr1, pr2, pr3 = _load(PR1), _load(PR2), _load(PR3)

    def tables():
        return set(inspect(create_engine(url)).get_table_names())

    def settings_columns():
        return {
            c["name"]
            for c in inspect(create_engine(url)).get_columns("msb_check_settings")
        }

    command.upgrade(cfg, BEFORE)
    command.upgrade(cfg, pr1.revision)
    assert set(pr1.TABLES) <= tables()
    assert "daily_limit_cents" not in settings_columns()
    command.upgrade(cfg, pr2.revision)
    assert set(pr2.TABLES) <= tables()
    assert "daily_limit_cents" in settings_columns()
    command.upgrade(cfg, pr3.revision)
    assert set(pr3.TABLES) <= tables()

    # PR 3 down leaves PR 2 intact.
    command.downgrade(cfg, pr2.revision)
    assert not set(pr3.TABLES) & tables()
    assert set(pr2.TABLES) <= tables()

    # PR 2 down leaves PR 1 intact.
    command.downgrade(cfg, pr1.revision)
    assert not set(pr2.TABLES) & tables()
    assert set(pr1.TABLES) <= tables()
    assert "daily_limit_cents" not in settings_columns()
    command.downgrade(cfg, BEFORE)
    assert not set(pr1.TABLES) & tables()
    command.downgrade(cfg, BEFORE)

    command.upgrade(cfg, pr3.revision)
    command.upgrade(cfg, pr3.revision)
    assert set(pr1.TABLES) | set(pr2.TABLES) | set(pr3.TABLES) <= tables()
