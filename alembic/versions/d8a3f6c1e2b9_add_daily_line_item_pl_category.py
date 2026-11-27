"""add msb_daily_line_item.pl_category: a daily entry's P&L line

With the Monthly P&L's Transactions tab on (flag `pl_transactions`),
a cash / check expense or purchase entry can be put on another
expense line of the P&L (a `pl_*` column or a store category), e.g.
a cash payment to the accountant on "Accounting". One nullable
column: additive, NULL on every existing row (= the line its kind
feeds, exactly as before). Idempotent both ways.

Revision ID: d8a3f6c1e2b9
Revises: c5e9a2d7f4b1
Create Date: 2026-11-27 06:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'd8a3f6c1e2b9'
down_revision: Union[str, None] = 'c5e9a2d7f4b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "msb_daily_line_item"
_COLUMN = "pl_category"


def _has_column() -> bool:
    cols = inspect(op.get_bind()).get_columns(_TABLE)
    return any(c["name"] == _COLUMN for c in cols)


def upgrade() -> None:
    if _has_column():
        return
    with op.batch_alter_table(_TABLE) as batch:
        batch.add_column(sa.Column(_COLUMN, sa.String(length=40), nullable=True))


def downgrade() -> None:
    if not _has_column():
        return
    with op.batch_alter_table(_TABLE) as batch:
        batch.drop_column(_COLUMN)
