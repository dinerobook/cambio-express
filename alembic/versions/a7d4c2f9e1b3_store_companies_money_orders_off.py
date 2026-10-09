"""add tenancy_store.companies_money_orders_off

CSV subset of the store's money-transfer companies that do NOT sell
money orders (Settings → Money transfer companies → "Money orders").
Additive only: a nullable column with no default, and NULL means
"every company sells money orders", so every existing store keeps
its Money orders tab exactly as before the moment this lands.

Idempotent add (survives a replay where the column already exists).

Revision ID: a7d4c2f9e1b3
Revises: f2a6c8e4b1d9
Create Date: 2026-10-09 23:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'a7d4c2f9e1b3'
down_revision: Union[str, None] = 'f2a6c8e4b1d9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "tenancy_store"
_COLUMN = "companies_money_orders_off"


def _has_column() -> bool:
    bind = op.get_bind()
    return _COLUMN in {c["name"] for c in inspect(bind).get_columns(_TABLE)}


def upgrade() -> None:
    if _has_column():
        return
    op.add_column(_TABLE, sa.Column(_COLUMN, sa.String(500), nullable=True))


def downgrade() -> None:
    if not _has_column():
        return
    with op.batch_alter_table(_TABLE) as batch:
        batch.drop_column(_COLUMN)
