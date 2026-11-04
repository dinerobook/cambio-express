"""add tenancy_user.language

Spanish in the app (owner, 2026-11-04): each person picks English or
Spanish under Settings → Profile.

Additive only: one nullable short string column on ``tenancy_user``.
NULL (or any value the app does not know) means English, so no backfill
is needed and nobody sees a change until they pick Spanish. The column
is spelled out here (a migration never imports application code);
``tests/Modules/Auth/test_profile_language.py`` asserts it matches the
model. Idempotent (survives a replay where the column already exists).

Revision ID: c4a9e2f7b1d5
Revises: b8e4f2a6c1d3
Create Date: 2026-11-04 01:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4a9e2f7b1d5'
down_revision: Union[str, None] = 'b8e4f2a6c1d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "tenancy_user"
COLUMN = "language"
LENGTH = 8


def _has_column(column: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return column in {c["name"] for c in insp.get_columns(TABLE)}


def upgrade() -> None:
    if not _has_column(COLUMN):
        op.add_column(
            TABLE, sa.Column(COLUMN, sa.String(LENGTH), nullable=True),
        )


def downgrade() -> None:
    if _has_column(COLUMN):
        with op.batch_alter_table(TABLE) as batch:
            batch.drop_column(COLUMN)
