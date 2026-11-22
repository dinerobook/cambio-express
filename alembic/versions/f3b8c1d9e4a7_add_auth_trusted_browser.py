"""add auth_trusted_browser: "Remember this browser" on the 2FA step

The owner signs out and in often and wants the 2FA code asked once per
browser, not at every sign-in. A browser remembered on the 2FA step
skips the code for 30 days, AFTER the password, never instead of it.

* ``auth_trusted_browser`` — one row per remembered browser: who, the
  sha256 of the cookie's secret (the raw secret lives only in the
  browser's httpOnly cookie), a fingerprint of the password and 2FA
  secret at that moment (a password change or 2FA reset forgets the
  browser), when it expires and was last used.

Additive only: one new table. Columns are spelled out here (a
migration never imports application code);
``tests/Modules/Auth/test_remembered_browser.py`` asserts they match
the model. Idempotent both ways.

Revision ID: f3b8c1d9e4a7
Revises: d7a3f9c2e5b8
Create Date: 2026-11-21 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3b8c1d9e4a7'
down_revision: Union[str, None] = 'd7a3f9c2e5b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "auth_trusted_browser"
USER_INDEX = "ix_auth_trusted_browser_user_id"


def _columns() -> list[sa.Column]:  # type: ignore[type-arg]
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("tenancy_user.id"), nullable=False),
        sa.Column("secret_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("stamp", sa.String(64), nullable=False),
        sa.Column("user_agent", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
    ]


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if TABLE not in insp.get_table_names():
        op.create_table(TABLE, *_columns())
        op.create_index(USER_INDEX, TABLE, ["user_id"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if TABLE in insp.get_table_names():
        op.drop_index(USER_INDEX, table_name=TABLE)
        op.drop_table(TABLE)
