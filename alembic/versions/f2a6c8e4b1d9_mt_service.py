"""daily book: bill payments, top-ups and recharges per company

One new table, ``msb_mt_service``, holding ``(store_id, report_date,
company, service) → amount, fees`` for the non-transfer services a
transfer provider handles at the counter. Additive only: no existing
table or row changes, and a day with no rows here reads exactly as
before.

Columns are spelled out literally here, never derived from the
models (CLAUDE.md "Migrations" — a migration is immutable history).

Revision ID: f2a6c8e4b1d9
Revises: d8f3b6a2c4e1
Create Date: 2026-10-09 08:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'f2a6c8e4b1d9'
down_revision: Union[str, None] = 'd8f3b6a2c4e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "msb_mt_service"


def upgrade() -> None:
    bind = op.get_bind()
    if _TABLE in inspect(bind).get_table_names():
        return
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("store_id", sa.Integer(), nullable=False),
        sa.Column("report_date", sa.Date(), nullable=False),
        sa.Column("company", sa.String(length=40), nullable=False),
        sa.Column("service", sa.String(length=20), nullable=False),
        sa.Column("amount_cents", sa.BigInteger(), nullable=True),
        sa.Column("fees_cents", sa.BigInteger(), nullable=True),
        sa.ForeignKeyConstraint(["store_id"], ["tenancy_store.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("store_id", "report_date", "company", "service",
                            name="uq_msb_mt_service_day"),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if _TABLE not in inspect(bind).get_table_names():
        return
    op.drop_table(_TABLE)
