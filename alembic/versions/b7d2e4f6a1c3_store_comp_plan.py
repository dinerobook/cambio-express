"""tenancy_store: comp-plan marker

Two columns on ``tenancy_store`` so a superadmin can give a store a
paid plan for free and the platform can tell a comped store from a
paying one: ``comped_at`` (when the comp started, NULL = not comped)
and ``comp_reason`` (operator context, shown on the store page and
in the audit log). Any Stripe subscription is paused while the comp
runs, so the plan field alone no longer has to carry that meaning.

Columns are spelled out literally here, never derived from the
models (CLAUDE.md "Migrations" — a migration is immutable history).

Revision ID: b7d2e4f6a1c3
Revises: e8c1f3a7d049
Create Date: 2026-10-08 06:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'b7d2e4f6a1c3'
down_revision: Union[str, None] = 'e8c1f3a7d049'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "tenancy_store"


def _columns() -> set[str]:
    bind = op.get_bind()
    return {c["name"] for c in inspect(bind).get_columns(_TABLE)}


def upgrade() -> None:
    have = _columns()
    if "comped_at" not in have:
        op.add_column(_TABLE, sa.Column("comped_at", sa.DateTime(), nullable=True))
    if "comp_reason" not in have:
        op.add_column(
            _TABLE,
            sa.Column("comp_reason", sa.String(length=200), nullable=True,
                      server_default=""),
        )


def downgrade() -> None:
    have = _columns()
    with op.batch_alter_table(_TABLE) as batch:
        if "comp_reason" in have:
            batch.drop_column("comp_reason")
        if "comped_at" in have:
            batch.drop_column("comped_at")
