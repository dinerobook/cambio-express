"""add notify_bell_dismissal

Top-bar notification bell (owner, 2026-11-04). The bell's items are
worked out live from the books and never stored; this table only
remembers that a person pressed Dismiss on an item, for one store
day. Tomorrow the item comes back if it is still true.

Additive only: one new table, nothing existing is touched, so every
current page and email keeps working exactly as before. ``user_id``
carries no foreign key on purpose (an owner dismisses in a store
their user row is not pinned to; deleting an employee must never be
blocked by a hidden reminder). Columns are spelled out here (a
migration never imports application code);
``tests/Modules/Notifications/test_bell_migration.py`` asserts they
match the model. Idempotent: survives a replay where the table
already exists.

Revision ID: c9d4e7a2f1b6
Revises: b8e4f2a6c1d3
Create Date: 2026-11-04 01:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9d4e7a2f1b6'
down_revision: Union[str, None] = 'b8e4f2a6c1d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "notify_bell_dismissal"
COLUMNS = (
    "id", "store_id", "user_id", "item_key", "dismissed_for", "created_at",
)
INDEX = "ix_notify_bell_dismissal_store_user_day"


def _has_table() -> bool:
    return TABLE in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table():
        return
    op.create_table(
        TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "store_id", sa.Integer(),
            sa.ForeignKey("tenancy_store.id"), nullable=False,
        ),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("item_key", sa.String(length=120), nullable=False),
        sa.Column("dismissed_for", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint(
            "store_id", "user_id", "item_key", "dismissed_for",
            name="uq_notify_bell_dismissal",
        ),
    )
    op.create_index(
        INDEX, TABLE, ["store_id", "user_id", "dismissed_for"],
    )


def downgrade() -> None:
    if not _has_table():
        return
    op.drop_index(INDEX, table_name=TABLE)
    op.drop_table(TABLE)
