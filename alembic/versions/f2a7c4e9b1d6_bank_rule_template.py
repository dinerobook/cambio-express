"""add bank_rule_template

Bank rules a superadmin writes once for every store (owner,
2026-10-21): "Intermex commission deposit", "Remote deposit fee", any
transaction type. A store copies one into its own ``bank_rule`` list
from the rules page; the template itself is never applied.

Additive only: one new table, nothing else touched. Columns are
spelled out here (a migration never imports application code);
``tests/Modules/BankSync/test_rule_templates.py`` asserts they match
the model.

Idempotent create (survives a replay where the table already exists).

Revision ID: f2a7c4e9b1d6
Revises: e5c9a1f3b7d2
Create Date: 2026-10-21 16:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'f2a7c4e9b1d6'
down_revision: Union[str, None] = 'e5c9a1f3b7d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "bank_rule_template"


def _has_table() -> bool:
    return TABLE in inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table():
        return
    op.create_table(
        TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.Column("desc_match_type", sa.String(20), nullable=False,
                  server_default=""),
        sa.Column("desc_match_value", sa.String(500), nullable=False,
                  server_default=""),
        sa.Column("sign_filter", sa.String(10), nullable=False,
                  server_default=""),
        sa.Column("amount_min_cents", sa.Integer(), nullable=True),
        sa.Column("amount_max_cents", sa.Integer(), nullable=True),
        sa.Column("target_kind", sa.String(40), nullable=False),
        sa.Column("auto_post", sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.Column("post_date_offset_days", sa.Integer(), nullable=False,
                  server_default="0"),
        sa.Column("created_by", sa.Integer(),
                  sa.ForeignKey("tenancy_user.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    if _has_table():
        op.drop_table(TABLE)
