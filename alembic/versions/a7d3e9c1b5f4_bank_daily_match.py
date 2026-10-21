"""add bank_daily_match + bank_transaction.dismissed_at / dismissed_by

Bank transactions matched to daily book entries (owner, 2026-10-21):
a bank row that arrives days after the cashier typed the same money
links to that entry instead of booking it a second time, and an admin
can dismiss rows that were already handled.

Additive only: one new table and two nullable columns on
``bank_transaction``. Nothing existing is renamed, dropped, retyped
or backfilled; every row written before this reads NULL = "not
dismissed", exactly as before. Columns are spelled out here (a
migration never imports application code);
``tests/Modules/BankSync/test_matching.py`` asserts they match the
model. Idempotent (survives a replay where the table / columns
already exist).

Revision ID: a7d3e9c1b5f4
Revises: f2a7c4e9b1d6
Create Date: 2026-10-21 21:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7d3e9c1b5f4'
down_revision: Union[str, None] = 'f2a7c4e9b1d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "bank_daily_match"
TXN_TABLE = "bank_transaction"
TXN_COLUMNS = (
    ("dismissed_at", sa.DateTime()),
    ("dismissed_by", sa.Integer()),
)


def _insp():
    return sa.inspect(op.get_bind())


def _has_column(table: str, column: str) -> bool:
    insp = _insp()
    if not insp.has_table(table):
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    for name, type_ in TXN_COLUMNS:
        if not _has_column(TXN_TABLE, name):
            op.add_column(TXN_TABLE, sa.Column(name, type_, nullable=True))
    if _insp().has_table(TABLE):
        return
    op.create_table(
        TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("store_id", sa.Integer(),
                  sa.ForeignKey("tenancy_store.id"), nullable=False),
        sa.Column("bank_transaction_id", sa.Integer(),
                  sa.ForeignKey("bank_transaction.id"), nullable=False),
        sa.Column("daily_line_item_id", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(12), nullable=False),
        sa.Column("method", sa.String(12), nullable=False,
                  server_default="auto"),
        sa.Column("created_by", sa.Integer(),
                  sa.ForeignKey("tenancy_user.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint(
            "bank_transaction_id", "daily_line_item_id",
            name="uq_bank_daily_match_pair",
        ),
    )
    op.create_index("ix_bank_daily_match_store_id", TABLE, ["store_id"])
    op.create_index(
        "ix_bank_daily_match_bank_transaction_id", TABLE,
        ["bank_transaction_id"],
    )
    op.create_index(
        "ix_bank_daily_match_daily_line_item_id", TABLE,
        ["daily_line_item_id"],
    )


def downgrade() -> None:
    if _insp().has_table(TABLE):
        op.drop_table(TABLE)
    with op.batch_alter_table(TXN_TABLE) as batch:
        for name, _ in reversed(TXN_COLUMNS):
            if _has_column(TXN_TABLE, name):
                batch.drop_column(name)
