"""add tenancy_user.notify_new_sign_in / notify_new_sign_in_push

New sign-in alert (owner, 2026-10-22): an email + push when someone
signs in to the account from a device it has not used before.

Additive only: two nullable boolean columns on ``tenancy_user``.
NULL means "the person never chose", which the app reads as off
(the owner chose off for everyone until each person switches it on),
so no backfill is needed and nobody starts getting a new email. Columns
are spelled out here (a migration never imports application code);
``tests/Modules/Notifications/test_new_sign_in.py`` asserts they
match the model. Idempotent (survives a replay where the columns
already exist).

Revision ID: b8e4f2a6c1d3
Revises: a7d3e9c1b5f4
Create Date: 2026-10-22 01:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8e4f2a6c1d3'
down_revision: Union[str, None] = 'a7d3e9c1b5f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "tenancy_user"
COLUMNS = ("notify_new_sign_in", "notify_new_sign_in_push")


def _has_column(column: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return column in {c["name"] for c in insp.get_columns(TABLE)}


def upgrade() -> None:
    for name in COLUMNS:
        if not _has_column(name):
            op.add_column(TABLE, sa.Column(name, sa.Boolean(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table(TABLE) as batch:
        for name in reversed(COLUMNS):
            if _has_column(name):
                batch.drop_column(name)
