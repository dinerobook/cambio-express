"""add msb_monthly_pl_category: a store's own P&L categories

The Monthly P&L's Transactions tab (flag `pl_transactions`) lets a
store add as many P&L categories as it likes (owner, 2026-11-27). A
new table, nothing else touched: additive, and empty until a store
with the switch on adds one. Idempotent both ways. Columns spelled
out (a migration never imports application code).

Revision ID: c5e9a2d7f4b1
Revises: b7d2f4a9c6e1
Create Date: 2026-11-27 05:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'c5e9a2d7f4b1'
down_revision: Union[str, None] = 'b7d2f4a9c6e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "msb_monthly_pl_category"


def upgrade() -> None:
    bind = op.get_bind()
    if _TABLE in inspect(bind).get_table_names():
        return
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("store_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("section", sa.String(length=10), nullable=False,
                  server_default="expense"),
        sa.Column("archived_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["store_id"], ["tenancy_store.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        f"ix_{_TABLE}_store_id", _TABLE, ["store_id"], unique=False,
    )


def downgrade() -> None:
    bind = op.get_bind()
    if _TABLE not in inspect(bind).get_table_names():
        return
    op.drop_index(f"ix_{_TABLE}_store_id", table_name=_TABLE)
    op.drop_table(_TABLE)
