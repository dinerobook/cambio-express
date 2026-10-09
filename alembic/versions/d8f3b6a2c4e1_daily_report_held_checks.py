"""add msb_daily_report held-check columns

A store can hold a client's cashed checks and deposit them on a
later day. Two NULL-able columns, no default, no backfill, no
constraint, no index: on Postgres each ADD COLUMN is a
metadata-only change, and NULL on every existing row reads as 0,
so no existing day's totals move. See DailyBook/INVARIANTS.md
"Held checks".

Columns spelled out literally, never derived from the model — a
migration is immutable history (CLAUDE.md "Migrations").

Revision ID: d8f3b6a2c4e1
Revises: c5e1a9d3f7b2
Create Date: 2026-10-09
"""
from alembic import op
import sqlalchemy as sa


revision = "d8f3b6a2c4e1"
down_revision = "c5e1a9d3f7b2"
branch_labels = None
depends_on = None


_TABLE = "msb_daily_report"
_COLUMNS = (
    "checks_held_cents",
    "held_checks_deposited_cents",
)


def _has_column(table: str, column: str) -> bool:
    insp = sa.inspect(op.get_bind())
    if not insp.has_table(table):
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    for name in _COLUMNS:
        if not _has_column(_TABLE, name):
            op.add_column(_TABLE, sa.Column(name, sa.BigInteger(), nullable=True))


def downgrade() -> None:
    # Dropping these loses the rolled-up held-check totals; the
    # entries themselves stay in msb_daily_line_item and a line-item
    # edit would re-derive them.
    with op.batch_alter_table(_TABLE) as batch:
        for name in reversed(_COLUMNS):
            if _has_column(_TABLE, name):
                batch.drop_column(name)
