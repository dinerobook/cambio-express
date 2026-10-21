"""The msb_mt_service migration spells its columns out literally (a
migration is immutable history), so this test runs it against an
empty database and checks it builds the same table the model maps."""
import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

_VERSIONS = Path(__file__).resolve().parents[3] / "alembic" / "versions"
_MIGRATION = _VERSIONS / "f2a6c8e4b1d9_mt_service.py"
# Adds the nullable money order count (and the store's per-order
# charges) — the table's later shape.
_COUNT_MIGRATION = _VERSIONS / "e5c9a1f3b7d2_money_order_count_and_charge.py"


def _load(path=_MIGRATION):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _upgraded_engine(*, with_count=True):
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE tenancy_store (id INTEGER PRIMARY KEY)"))
        ctx = MigrationContext.configure(conn)
        with Operations.context(ctx):
            for path in (_MIGRATION, _COUNT_MIGRATION)[:2 if with_count else 1]:
                mig = _load(path)
                mig.upgrade()
                mig.upgrade()  # idempotent: a second run is a no-op
    return engine


def test_migration_builds_the_model_table():
    from api.Modules.DailyBook.Models import MoneyServiceSummary
    insp = sa.inspect(_upgraded_engine())
    cols = {c["name"]: c for c in insp.get_columns("msb_mt_service")}
    model = MoneyServiceSummary.__table__
    assert set(cols) == {c.name for c in model.columns}
    for c in model.columns:
        assert cols[c.name]["nullable"] == c.nullable or c.primary_key, c.name
    uniques = {tuple(u["column_names"]) for u in insp.get_unique_constraints("msb_mt_service")}
    assert ("store_id", "report_date", "company", "service") in uniques


def test_count_migration_adds_two_nullable_columns_and_reverses():
    engine = _upgraded_engine()
    insp = sa.inspect(engine)
    cols = {c["name"]: c for c in insp.get_columns("msb_mt_service")}
    assert cols["item_count"]["nullable"] is True
    store_cols = {c["name"]: c for c in insp.get_columns("tenancy_store")}
    assert store_cols["money_order_charges"]["nullable"] is True
    with engine.begin() as conn:
        ctx = MigrationContext.configure(conn)
        with Operations.context(ctx):
            _load(_COUNT_MIGRATION).downgrade()
    insp = sa.inspect(engine)
    assert "item_count" not in {c["name"] for c in insp.get_columns("msb_mt_service")}
    assert {c["name"] for c in insp.get_columns("tenancy_store")} == {"id"}


def test_downgrade_drops_only_the_new_table():
    engine = _upgraded_engine(with_count=False)
    with engine.begin() as conn:
        ctx = MigrationContext.configure(conn)
        with Operations.context(ctx):
            _load().downgrade()
    assert sa.inspect(engine).get_table_names() == ["tenancy_store"]


def test_migration_does_not_import_application_code():
    for line in (
        _MIGRATION.read_text() + _COUNT_MIGRATION.read_text()
    ).splitlines():
        stripped = line.strip()
        assert not stripped.startswith(("import api", "from api")), stripped
