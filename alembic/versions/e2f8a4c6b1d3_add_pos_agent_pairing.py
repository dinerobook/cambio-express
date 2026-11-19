"""add retail_pos_agent_pairing (connect codes for DineroBook Manager)

DineroBook Manager on a store PC used to sign in with a DineroBook
username and password to get the store's agent key. The owner's rule
(2026-11-19) is that nobody at the store types a name or a password,
so the Register import page now makes a one-time connect code and the
Manager trades it for the key (``POST /posimport/agent/pair``).

This table holds those codes: sha256 only, ten minutes, one use, and
the key each one became.

Additive only: one new table, nothing existing changes. Columns are
spelled out here (a migration never imports application code);
``tests/Modules/PosImport/test_agent_pairing.py`` asserts they match
the model. Idempotent both ways.

Revision ID: e2f8a4c6b1d3
Revises: b9e5c3a7d1f4
Create Date: 2026-11-19 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e2f8a4c6b1d3'
down_revision: Union[str, None] = 'b9e5c3a7d1f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "retail_pos_agent_pairing"


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table(TABLE):
        return
    op.create_table(
        TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_by_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column(
            "credential_id", sa.Integer(),
            sa.ForeignKey("retail_pos_agent_credential.id"), nullable=True,
        ),
        sa.UniqueConstraint("code_hash", name=f"uq_{TABLE}_code_hash"),
    )
    op.create_index(f"ix_{TABLE}_store_id", TABLE, ["store_id"])


def downgrade() -> None:
    if not _has_table(TABLE):
        return
    op.drop_index(f"ix_{TABLE}_store_id", table_name=TABLE)
    op.drop_table(TABLE)
