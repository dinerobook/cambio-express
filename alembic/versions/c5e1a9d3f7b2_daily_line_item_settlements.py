"""add msb_daily_line_item settlement columns

Cash lent out (or borrowed) through the daily book's Other cash out /
Other cash in boxes can be marked as money that comes back. Three
NULL-able columns, no default, no backfill, no constraint, no index:
on Postgres each ADD COLUMN is a metadata-only change, and NULL on
every existing row means "a plain entry", which is what every
existing row is. See DailyBook/INVARIANTS.md "Settlements".

Columns spelled out literally, never derived from the model — a
migration is immutable history (CLAUDE.md "Migrations").

Revision ID: c5e1a9d3f7b2
Revises: b7d2e4f6a1c3
Create Date: 2026-10-08
"""
from alembic import op
import sqlalchemy as sa


revision = "c5e1a9d3f7b2"
down_revision = "b7d2e4f6a1c3"
branch_labels = None
depends_on = None


_TABLE = "msb_daily_line_item"
_COLUMNS = (
    ("expects_settlement", sa.Boolean),
    ("settle_by", sa.Date),
    ("settles_item_id", sa.Integer),
)


def _has_column(table: str, column: str) -> bool:
    insp = sa.inspect(op.get_bind())
    if not insp.has_table(table):
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    for name, type_ in _COLUMNS:
        if not _has_column(_TABLE, name):
            op.add_column(_TABLE, sa.Column(name, type_(), nullable=True))


def downgrade() -> None:
    # Dropping these forgets which entries were lent / borrowed and
    # which entries paid them back. The entries themselves and every
    # day's totals are untouched — the money already moved through
    # the ordinary other_cash_in / other_cash_out kinds.
    with op.batch_alter_table(_TABLE) as batch:
        for name, _ in reversed(_COLUMNS):
            if _has_column(_TABLE, name):
                batch.drop_column(name)
