"""link fuel prepay deposits to their completions in the POS import

Passport writes a prepaid fuel ticket twice: the deposit when the
customer pays, and a completion (LinkedTransactionInfo, reason
fuelPrepay) that restates the whole ticket once the pump stops. The
import counted both. These columns let it tell the halves apart:

* ``retail_pos_journal_file.prepay_key`` — shared by a staged deposit
  and its completion, so a day's commit finds a completion staged on
  a later business day with one indexed lookup;
* ``retail_pos_transaction.linked_*`` — the deposit a completion
  restates, as Passport names it;
* ``retail_pos_transaction.superseded`` / ``superseded_by_file`` — a
  deposit whose completion exists: shown in the viewer, left out of
  every money total.

Additive only: new columns with server defaults (one nullable) and
one index. Every row is derived from the staged journal files, so
nothing needs a backfill: the next commit of a day fills them.
Columns are spelled out here (a migration never imports application
code); ``tests/Modules/PosImport/test_prepay_link_migration.py``
asserts they match the models. Idempotent both ways.

Revision ID: a6c1e9f4b2d7
Revises: b3e7c1a9d5f2
Create Date: 2026-11-18 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a6c1e9f4b2d7'
down_revision: Union[str, None] = 'b3e7c1a9d5f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Table → its new columns, in model order: (name, type, server
# default). A default of None means the column is nullable.
ADDED: dict[str, tuple[tuple[str, sa.types.TypeEngine, str | None], ...]] = {  # type: ignore[type-arg]
    "retail_pos_journal_file": (
        ("prepay_key", sa.String(length=80), ""),
    ),
    "retail_pos_transaction": (
        ("linked_reason", sa.String(length=30), ""),
        ("linked_register_id", sa.String(length=20), ""),
        ("linked_transaction_no", sa.String(length=30), ""),
        ("linked_started_at", sa.DateTime(), None),
        ("superseded", sa.Boolean(), "0"),
        ("superseded_by_file", sa.String(length=120), ""),
    ),
}

ADDED_COLUMNS: dict[str, tuple[str, ...]] = {
    table: tuple(name for name, _type, _default in cols)
    for table, cols in ADDED.items()
}

INDEXES: dict[str, tuple[str, list[str]]] = {
    "ix_retail_pos_journal_file_prepay_key": (
        "retail_pos_journal_file", ["store_id", "prepay_key"],
    ),
}


def _inspector() -> sa.engine.reflection.Inspector:
    return sa.inspect(op.get_bind())


def _column(name: str, type_: sa.types.TypeEngine, default: str | None) -> sa.Column:  # type: ignore[type-arg]
    if default is None:
        return sa.Column(name, type_, nullable=True)
    return sa.Column(
        name, type_, nullable=False,
        # ``false()`` renders FALSE on Postgres, 0 on SQLite.
        server_default=sa.false() if isinstance(type_, sa.Boolean) else default,
    )


def upgrade() -> None:
    insp = _inspector()
    for table, cols in ADDED.items():
        have = {c["name"] for c in insp.get_columns(table)}
        missing = [c for c in cols if c[0] not in have]
        if missing:
            with op.batch_alter_table(table) as batch:
                for name, type_, default in missing:
                    batch.add_column(_column(name, type_, default))
    insp = _inspector()
    for name, (table, cols) in INDEXES.items():
        if name not in {i["name"] for i in insp.get_indexes(table)}:
            op.create_index(name, table, cols)


def downgrade() -> None:
    insp = _inspector()
    for name, (table, _cols) in INDEXES.items():
        if name in {i["name"] for i in insp.get_indexes(table)}:
            op.drop_index(name, table_name=table)
    for table, cols in ADDED.items():
        have = {c["name"] for c in insp.get_columns(table)}
        present = [name for name, _t, _d in cols if name in have]
        if present:
            with op.batch_alter_table(table) as batch:
                for name in reversed(present):
                    batch.drop_column(name)
