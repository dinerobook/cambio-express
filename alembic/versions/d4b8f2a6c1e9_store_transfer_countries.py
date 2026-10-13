"""add tenancy_store.transfer_countries

The store's own list of countries for the transfer form's country
picker (Settings → General → Transfer countries), CSV in display
order. Additive only: a nullable column with no default, and NULL
means "the built-in list the form has always shown", so every
existing store keeps exactly the same countries until an admin
edits the list.

Idempotent add (survives a replay where the column already exists).

Revision ID: d4b8f2a6c1e9
Revises: c3e9a1d7f5b2
Create Date: 2026-10-13 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'd4b8f2a6c1e9'
down_revision: Union[str, None] = 'c3e9a1d7f5b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "tenancy_store"
_COLUMN = "transfer_countries"


def _has_column() -> bool:
    bind = op.get_bind()
    return _COLUMN in {c["name"] for c in inspect(bind).get_columns(_TABLE)}


def upgrade() -> None:
    if _has_column():
        return
    op.add_column(_TABLE, sa.Column(_COLUMN, sa.Text(), nullable=True))


def downgrade() -> None:
    if not _has_column():
        return
    with op.batch_alter_table(_TABLE) as batch:
        batch.drop_column(_COLUMN)
