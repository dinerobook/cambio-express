"""bank feed: choose the daily-book day a transaction posts on

Two columns, both nullable / defaulted so existing rows keep their
current behaviour (book on the bank's own ``posted_at`` date):

* ``bank_transaction.report_date_override`` — the day a tagged row
  books on when the operator picked one. NULL = the bank's date.
* ``bank_rule.post_date_offset_days`` — shift the booked day N days
  from the bank's date when the rule books a line. 0 = no shift.

Columns are spelled out literally here, never derived from the
models (CLAUDE.md "Migrations" — a migration is immutable history).

Revision ID: a3d5f81c9b27
Revises: c4a9e7d21f08
Create Date: 2026-09-18 03:45:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'a3d5f81c9b27'
down_revision: Union[str, None] = 'c4a9e7d21f08'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, fresh-Column factory). A Column instance can only be bound
# to one Table, so each entry builds a new one per call.
_ADDITIONS = (
    ("bank_transaction",
     lambda: sa.Column("report_date_override", sa.Date(), nullable=True)),
    ("bank_rule",
     lambda: sa.Column("post_date_offset_days", sa.Integer(),
                       nullable=False, server_default="0")),
)


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    return column in {c["name"] for c in inspect(bind).get_columns(table)}


def upgrade() -> None:
    for table, factory in _ADDITIONS:
        col = factory()
        if not _has_column(table, col.name):
            op.add_column(table, col)


def downgrade() -> None:
    for table, factory in reversed(_ADDITIONS):
        name = factory().name
        if _has_column(table, name):
            op.drop_column(table, name)
