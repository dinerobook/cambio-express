"""The fuel prepay link migration (a6c1e9f4b2d7) spells out exactly
the models' new columns and index, imports no application code, keeps
existing rows, and runs up and down twice (idempotent both ways)."""
import importlib.util
from datetime import date
from pathlib import Path

from api.Modules.PosImport.Models import PosJournalFile, PosTransaction

ROOT = Path(__file__).resolve().parents[3]
PATH = ROOT / "alembic" / "versions" / "a6c1e9f4b2d7_add_pos_prepay_link.py"


def _load():
    spec = importlib.util.spec_from_file_location(PATH.stem, PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_matches_the_models():
    m = _load()
    for model in (PosJournalFile, PosTransaction):
        table = model.__table__
        added = list(m.ADDED_COLUMNS[table.name])
        # The new columns sit together in model order (later revisions
        # may add columns after them).
        names = [c.name for c in table.columns]
        first = names.index(added[0])
        assert names[first:first + len(added)] == added
        for name, type_, default in m.ADDED[table.name]:
            column = table.columns[name]
            assert type(column.type) is type(type_), name
            assert column.nullable is (default is None), name
    model_indexes = {
        i.name: (i.table.name, [c.name for c in i.columns])
        for i in PosJournalFile.__table__.indexes
        if "prepay_key" in [c.name for c in i.columns]
    }
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
    url = f"sqlite:///{tmp_path / 'prepay.db'}"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    engine = create_engine(url)

    def columns(table):
        return {c["name"] for c in inspect(engine).get_columns(table)}

    def indexes():
        return {
            i["name"] for i in inspect(engine).get_indexes("retail_pos_journal_file")
        }

    command.upgrade(cfg, m.down_revision)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO retail_pos_journal_file (store_id, filename, "
            "business_date, event_kind, parse_error, content_gz) "
            "VALUES (1, 'PJR-old.xml', :d, 'sale', '', x'00')"
        ), {"d": date(2025, 3, 4)})
        conn.execute(text(
            "INSERT INTO retail_pos_transaction (store_id, business_date, "
            "source_file, kind, register_id, cashier_id, till_id, "
            "transaction_no, event_sequence_id, outside, training_mode, "
            "offline, suspended, gross_cents, net_cents, tax_cents, "
            "grand_total_cents, has_voided_line) VALUES (1, :d, "
            "'PJR-old.xml', 'sale', '1', '3', '', '8945', '', 0, 0, 0, 0, "
            "300, 300, 0, 300, 0)"
        ), {"d": date(2025, 3, 4)})

    for _ in range(2):
        command.upgrade(cfg, m.revision)
        for table, added in m.ADDED_COLUMNS.items():
            assert set(added) <= columns(table)
        assert set(m.INDEXES) <= indexes()
    with engine.connect() as conn:
        assert conn.execute(text(
            "SELECT prepay_key FROM retail_pos_journal_file"
        )).one() == ("",)
        row = conn.execute(text(
            "SELECT superseded, superseded_by_file, linked_reason, "
            "linked_started_at FROM retail_pos_transaction"
        )).one()
        assert tuple(row) == (0, "", "", None)

    for _ in range(2):
        command.downgrade(cfg, m.down_revision)
        for table, added in m.ADDED_COLUMNS.items():
            assert not set(added) & columns(table)
        assert not set(m.INDEXES) & indexes()
    with engine.connect() as conn:
        assert conn.execute(text(
            "SELECT COUNT(*) FROM retail_pos_transaction"
        )).scalar() == 1

    command.upgrade(cfg, m.revision)
