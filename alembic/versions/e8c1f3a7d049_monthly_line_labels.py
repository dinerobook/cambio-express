"""monthly P&L: a store's own name for a P&L line

One table, ``msb_monthly_line_label``, holding ``(store_id, field)
→ label``. It is a display layer over the fixed
``msb_monthly_financial`` columns: renaming a line moves no money
and rewrites no history, it only changes what the operator reads on
the P&L form and in the bank-category picker.

Columns are spelled out literally here, never derived from the
models (CLAUDE.md "Migrations" — a migration is immutable history).

Revision ID: e8c1f3a7d049
Revises: a3d5f81c9b27
Create Date: 2026-09-18 05:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'e8c1f3a7d049'
down_revision: Union[str, None] = 'a3d5f81c9b27'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "msb_monthly_line_label"


def upgrade() -> None:
    bind = op.get_bind()
    if _TABLE in inspect(bind).get_table_names():
        return
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("store_id", sa.Integer(), nullable=False),
        sa.Column("field", sa.String(length=40), nullable=False),
        sa.Column("label", sa.String(length=60), nullable=False,
                  server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["store_id"], ["tenancy_store.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("store_id", "field",
                            name="uq_monthly_line_label"),
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
