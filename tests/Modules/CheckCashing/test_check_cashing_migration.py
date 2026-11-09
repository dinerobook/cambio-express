"""The check cashing migration spells out exactly the models' columns
and indexes, imports no application code, and runs up and down twice
(idempotent both ways)."""
import importlib.util
from pathlib import Path

from api.Modules.CheckCashing.Models import (
    CheckCashingSettings, CheckCompany, CheckCustomer, CheckCustomerId,
)

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "alembic" / "versions" / "d5e8a1c3f7b9_add_check_cashing.py"
MODELS = (CheckCashingSettings, CheckCustomer, CheckCustomerId, CheckCompany)


def _migration():
    spec = importlib.util.spec_from_file_location("cc_migration", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_matches_the_models():
    m = _migration()
    assert set(m.TABLES) == {model.__tablename__ for model in MODELS}
    for model in MODELS:
        assert tuple(m.TABLES[model.__tablename__]) == tuple(
            c.name for c in model.__table__.columns
        ), model.__tablename__
    model_indexes = {
        i.name: (i.table.name, [c.name for c in i.columns])
        for model in MODELS for i in model.__table__.indexes
    }
    assert {k: (t, list(c)) for k, (t, c) in m.INDEXES.items()} == model_indexes


def test_migration_does_not_import_application_code():
    for line in MIGRATION.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped


def test_migration_runs_up_and_down_twice(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect

    url = f"sqlite:///{tmp_path / 'cc.db'}"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    tables = set(_migration().TABLES)
    command.upgrade(cfg, "c9d4e7a2f1b6")
    command.upgrade(cfg, "d5e8a1c3f7b9")
    engine = create_engine(url)
    assert tables <= set(inspect(engine).get_table_names())
    command.downgrade(cfg, "c9d4e7a2f1b6")
    assert not tables & set(inspect(create_engine(url)).get_table_names())
    command.downgrade(cfg, "c9d4e7a2f1b6")
    command.upgrade(cfg, "d5e8a1c3f7b9")
    command.upgrade(cfg, "d5e8a1c3f7b9")
    assert tables <= set(inspect(create_engine(url)).get_table_names())
