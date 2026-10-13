"""debit card + payout money transfers

Three nullable columns, no defaults, no backfill:

* ``msb_transfer.payment_method`` — how the customer paid for a send:
  ``"cash"`` or ``"debit_card"`` (paid on the company's card terminal,
  so no cash reached the drawer). NULL on every existing row and read
  as cash, which is what every existing row was.
* ``msb_mt_summary.debit_card_cents`` — the part of a company's day
  (as typed on the daily book) that was paid by debit card.
* ``msb_mt_summary.payouts_cents`` — cash the store paid out to
  recipients for that company that day.

Both summary columns come off the company's day total, so NULL (read
as 0) leaves every saved day exactly as it was. Adding a nullable
column without a default is a catalogue-only change on Postgres: no
table rewrite, no long lock on a live table.

Idempotent add (survives a replay where a column already exists).

Revision ID: c3e9a1d7f5b2
Revises: c8e1a5d3f7b2
Create Date: 2026-10-13 07:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'c3e9a1d7f5b2'
down_revision: Union[str, None] = 'c8e1a5d3f7b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_COLUMNS: tuple[tuple[str, str, sa.types.TypeEngine], ...] = (
    ("msb_transfer", "payment_method", sa.String(20)),
    ("msb_mt_summary", "debit_card_cents", sa.BigInteger()),
    ("msb_mt_summary", "payouts_cents", sa.BigInteger()),
)


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    return column in {c["name"] for c in inspect(bind).get_columns(table)}


def upgrade() -> None:
    for table, column, type_ in _COLUMNS:
        if not _has_column(table, column):
            op.add_column(table, sa.Column(column, type_, nullable=True))


def downgrade() -> None:
    for table, column, _ in reversed(_COLUMNS):
        if _has_column(table, column):
            with op.batch_alter_table(table) as batch:
                batch.drop_column(column)
