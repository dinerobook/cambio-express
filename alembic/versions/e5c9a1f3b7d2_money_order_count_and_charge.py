"""add msb_mt_service.item_count + tenancy_store.money_order_charges

Money order fees reach the Monthly P&L net of what each company
charges the store per money order (owner, 2026-10-20). That needs two
figures we did not keep:

* ``msb_mt_service.item_count`` — how many were sold, typed per
  company on the daily book's Money orders tab.
* ``tenancy_store.money_order_charges`` — JSON ``{company: dollars}``,
  what each company charges per money order (Settings → Money
  services).

Additive only: two nullable columns, no defaults, no backfill. NULL
reads as "no count" / "no charge", so every saved day and every
store reads exactly as before the moment this lands.

Idempotent add (survives a replay where a column already exists).

Revision ID: e5c9a1f3b7d2
Revises: d4b8f2a6c1e9
Create Date: 2026-10-20 21:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'e5c9a1f3b7d2'
down_revision: Union[str, None] = 'd4b8f2a6c1e9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_COLUMNS = (
    ("msb_mt_service", "item_count", sa.Integer()),
    ("tenancy_store", "money_order_charges", sa.Text()),
)


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    return column in {c["name"] for c in inspect(bind).get_columns(table)}


def upgrade() -> None:
    for table, column, type_ in _COLUMNS:
        if not _has_column(table, column):
            op.add_column(table, sa.Column(column, type_, nullable=True))


def downgrade() -> None:
    for table, column, _type in reversed(_COLUMNS):
        if _has_column(table, column):
            with op.batch_alter_table(table) as batch:
                batch.drop_column(column)
