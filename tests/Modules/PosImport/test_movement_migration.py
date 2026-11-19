"""The movement-report migration (b9e5c3a7d1f4) spells out exactly the
models' five tables — columns, types, nullability, the report-row
unique constraint — imports no application code, and runs up and
down twice."""
import importlib.util
from pathlib import Path

from sqlalchemy import UniqueConstraint

from api.Modules.PosImport.Models import (
    PosFuelGradeMovement,
    PosItemSalesMovement,
    PosMerchandiseCodeMovement,
    PosMiscSummaryMovement,
    PosTaxLevelMovement,
)

ROOT = Path(__file__).resolve().parents[3]
PATH = ROOT / "alembic" / "versions" / "b9e5c3a7d1f4_add_pos_movement_reports.py"
MODELS = (
    PosFuelGradeMovement, PosMerchandiseCodeMovement, PosItemSalesMovement,
    PosMiscSummaryMovement, PosTaxLevelMovement,
)


def _load():
    spec = importlib.util.spec_from_file_location(PATH.stem, PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _shape(type_) -> str:
    return type_.compile()


def test_migration_matches_the_models():
    m = _load()
    assert set(m.TABLES) == {model.__tablename__ for model in MODELS}
    for model in MODELS:
        specs = (
            [("id", None, False, None), ("store_id", None, False, None)]
            + list(m.HEADER) + list(m.TABLES[model.__tablename__])
        )
        migration = {
            name: (None if t is None else _shape(t), nullable)
            for name, t, nullable, _default in specs
        }
        cols = model.__table__.columns
        assert list(migration) == [c.name for c in cols], model.__tablename__
        for c in cols:
            if c.name in ("id", "store_id"):
                continue
            assert migration[c.name] == (_shape(c.type), c.nullable), (
                model.__tablename__, c.name,
            )
        [unique] = [
            u for u in model.__table__.constraints
            if isinstance(u, UniqueConstraint)
        ]
        assert unique.name == m._unique_name(model.__tablename__)
        assert tuple(c.name for c in unique.columns) == m.UNIQUE_COLUMNS


def test_every_not_null_column_has_a_server_default_or_is_the_key():
    """Additive: a row written by code that predates a column still
    inserts. Only the report key and the file name have no default,
    and ingest always writes those."""
    m = _load()
    no_default = {
        name for name, _t, nullable, default in m.HEADER
        if not nullable and default is None
    }
    assert no_default == {
        "source_file", "business_date", "begin_date", "begin_time",
        "detail_seq",
    }
    for table, columns in m.TABLES.items():
        for name, _t, nullable, default in columns:
            assert nullable or default is not None, (table, name)


def test_migration_does_not_import_application_code():
    for line in PATH.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped


def test_migration_runs_up_and_down_twice(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect

    m = _load()
    url = f"sqlite:///{tmp_path / 'mv.db'}"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    engine = create_engine(url)

    def tables():
        return set(inspect(engine).get_table_names())

    command.upgrade(cfg, m.down_revision)
    assert not set(m.TABLES) & tables()
    command.upgrade(cfg, m.revision)
    assert set(m.TABLES) <= tables()
    for model in MODELS:
        cols = {c["name"] for c in inspect(engine).get_columns(model.__tablename__)}
        assert cols == {c.name for c in model.__table__.columns}
        uniques = inspect(engine).get_unique_constraints(model.__tablename__)
        assert [u["name"] for u in uniques] == [
            m._unique_name(model.__tablename__),
        ]
    command.upgrade(cfg, m.revision)

    command.downgrade(cfg, m.down_revision)
    assert not set(m.TABLES) & tables()
    command.downgrade(cfg, m.down_revision)

    command.upgrade(cfg, m.revision)
    command.upgrade(cfg, m.revision)
    assert set(m.TABLES) <= tables()
