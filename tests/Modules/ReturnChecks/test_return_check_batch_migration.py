"""The returned-check batch migration (c8e2f4a6b1d9) spells out exactly
the models' new table, columns and indexes, imports no application
code, keeps existing checks untouched, and runs up and down twice."""
import importlib.util
from datetime import date
from pathlib import Path

from api.Modules.ReturnChecks.Models import ReturnCheck, ReturnCheckBatch

ROOT = Path(__file__).resolve().parents[3]
PATH = ROOT / "alembic" / "versions" / "c8e2f4a6b1d9_add_return_check_batches.py"


def _load():
    spec = importlib.util.spec_from_file_location(PATH.stem, PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_matches_the_models():
    m = _load()
    assert list(m.TABLES["msb_return_check_batch"]) == [
        c.name for c in ReturnCheckBatch.__table__.columns
    ]
    model_cols = [c.name for c in ReturnCheck.__table__.columns]
    for col in m.ADDED_COLUMNS["msb_return_check"]:
        assert col in model_cols
    model_indexes = {
        i.name: (i.table.name, [c.name for c in i.columns])
        for i in ReturnCheckBatch.__table__.indexes
    }
    model_indexes.update({
        i.name: (i.table.name, [c.name for c in i.columns])
        for i in ReturnCheck.__table__.indexes
        if "batch_id" in [c.name for c in i.columns]
    })
    assert {k: (t, list(c)) for k, (t, c) in m.INDEXES.items()} == model_indexes


def test_migration_does_not_import_application_code():
    for line in PATH.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped


def test_migration_runs_up_and_down_twice_and_keeps_old_rows(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect, text

    m = _load()
    url = f"sqlite:///{tmp_path / 'rc.db'}"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    engine = create_engine(url)

    def tables():
        return set(inspect(engine).get_table_names())

    def rc_columns():
        return {c["name"] for c in inspect(engine).get_columns("msb_return_check")}

    command.upgrade(cfg, m.down_revision)
    with engine.begin() as conn:
        # SQLite leaves foreign keys unchecked here, so no store row
        # is needed for the check that must survive the round trip.
        conn.execute(text(
            "INSERT INTO msb_return_check (store_id, bounced_on, customer_name, "
            "company_name, amount_cents, return_check_fee_cents, status) "
            "VALUES (1, :d, 'Ana', 'Acme', 50000, 0, 'pending')"
        ), {"d": date(2026, 11, 1)})

    command.upgrade(cfg, m.revision)
    assert "msb_return_check_batch" in tables()
    assert set(m.ADDED_COLUMNS["msb_return_check"]) <= rc_columns()
    with engine.connect() as conn:
        row = conn.execute(text(
            "SELECT customer_name, amount_cents, batch_id, routing_number "
            "FROM msb_return_check"
        )).one()
    assert tuple(row) == ("Ana", 50000, None, None)
    command.upgrade(cfg, m.revision)

    command.downgrade(cfg, m.down_revision)
    assert "msb_return_check_batch" not in tables()
    assert not set(m.ADDED_COLUMNS["msb_return_check"]) & rc_columns()
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM msb_return_check")).scalar() == 1
    command.downgrade(cfg, m.down_revision)

    command.upgrade(cfg, m.revision)
    command.upgrade(cfg, m.revision)
    assert "msb_return_check_batch" in tables()
