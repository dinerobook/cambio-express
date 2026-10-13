"""The debit card / payouts migration adds three nullable columns to
live tables. It spells them out literally (a migration is immutable
history), so this test runs it on bare copies of the two tables and
checks it adds what the models map: nullable, no default, idempotent,
and a downgrade that removes only them."""
import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

_MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "alembic" / "versions"
    / "c3e9a1d7f5b2_transfer_payment_method_and_payouts.py"
)

_NEW = {
    "msb_transfer": {"payment_method"},
    "msb_mt_summary": {"debit_card_cents", "payouts_cents"},
}


def _load():
    spec = importlib.util.spec_from_file_location("pm_mig", _MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(engine, fn_name):
    with engine.begin() as conn:
        ctx = MigrationContext.configure(conn)
        with Operations.context(ctx):
            getattr(_load(), fn_name)()


def _engine():
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text(
            "CREATE TABLE msb_transfer (id INTEGER PRIMARY KEY, "
            "service_type VARCHAR(30))"))
        conn.execute(sa.text(
            "CREATE TABLE msb_mt_summary (id INTEGER PRIMARY KEY, "
            "amount_cents BIGINT)"))
        conn.execute(sa.text(
            "INSERT INTO msb_transfer (id, service_type) VALUES (1, 'Money Transfer')"))
        conn.execute(sa.text(
            "INSERT INTO msb_mt_summary (id, amount_cents) VALUES (1, 500)"))
    return engine


def test_adds_nullable_columns_matching_the_models():
    from api.Modules.DailyBook.Models import MoneyTransferSummary
    from api.Modules.Transfers.Models import Transfer
    engine = _engine()
    _run(engine, "upgrade")
    _run(engine, "upgrade")  # idempotent: a replay is a no-op
    insp = sa.inspect(engine)
    models = {"msb_transfer": Transfer, "msb_mt_summary": MoneyTransferSummary}
    for table, cols in _NEW.items():
        live = {c["name"]: c for c in insp.get_columns(table)}
        for name in cols:
            assert live[name]["nullable"], (table, name)
            assert live[name]["default"] is None, (table, name)
            assert models[table].__table__.c[name].nullable, (table, name)
    # Existing rows read NULL: cash, and nothing off the day's total.
    with engine.connect() as conn:
        assert conn.execute(sa.text(
            "SELECT payment_method FROM msb_transfer")).scalar() is None
        assert conn.execute(sa.text(
            "SELECT debit_card_cents, payouts_cents FROM msb_mt_summary"
        )).one() == (None, None)


def test_downgrade_removes_only_the_new_columns():
    engine = _engine()
    _run(engine, "upgrade")
    _run(engine, "downgrade")
    insp = sa.inspect(engine)
    assert {c["name"] for c in insp.get_columns("msb_transfer")} == {
        "id", "service_type"}
    assert {c["name"] for c in insp.get_columns("msb_mt_summary")} == {
        "id", "amount_cents"}


def test_migration_does_not_import_application_code():
    for line in _MIGRATION.read_text().splitlines():
        stripped = line.strip()
        assert not stripped.startswith(("import api", "from api")), stripped
