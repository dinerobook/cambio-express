"""add cashier names and a register event's detail type (Transactions)

The Transactions page is getting a receipt view built on what the
owner's other back offices show (Cronysoft's receipts, Modisoft's
item report). Two things it needs were not stored:

* ``retail_pos_transaction.detail_type`` — what a non-sale register
  event was: Passport's alert description ("NoSale": the drawer
  opened with nothing sold) or its register detail type ("open",
  "close"). The page's "No sales" view filters on it.
* ``retail_pos_cashier`` — the name a store gives each cashier
  number. The journal carries only the number ("91").

Additive only: one column with a server default and one new table.
``detail_type`` is derived from the staged journal files, so nothing
needs a backfill: the next commit (or Re-book) of a day fills it.
Columns are spelled out here (a migration never imports application
code); ``tests/Modules/PosImport/test_cashier_names.py`` asserts they
match the models. Idempotent both ways.

Revision ID: d7a3f9c2e5b8
Revises: e2f8a4c6b1d3
Create Date: 2026-11-20 19:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd7a3f9c2e5b8'
down_revision: Union[str, None] = 'e2f8a4c6b1d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TRANSACTION_TABLE = "retail_pos_transaction"
DETAIL_COLUMN = ("detail_type", sa.String(length=40), "")
CASHIER_TABLE = "retail_pos_cashier"
CASHIER_UNIQUE = "uq_retail_pos_cashier_store_cashier"
CASHIER_INDEX = "ix_retail_pos_cashier_store_id"


def _cashier_columns() -> list[sa.Column]:  # type: ignore[type-arg]
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"), nullable=False),
        sa.Column("cashier_id", sa.String(20), nullable=False),
        sa.Column("name", sa.String(80), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    ]


def _inspector() -> sa.engine.reflection.Inspector:
    return sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _inspector()
    have = {c["name"] for c in insp.get_columns(TRANSACTION_TABLE)}
    name, type_, default = DETAIL_COLUMN
    if name not in have:
        with op.batch_alter_table(TRANSACTION_TABLE) as batch:
            batch.add_column(sa.Column(
                name, type_, nullable=False, server_default=default,
            ))
    if CASHIER_TABLE not in insp.get_table_names():
        op.create_table(
            CASHIER_TABLE,
            *_cashier_columns(),
            sa.UniqueConstraint("store_id", "cashier_id", name=CASHIER_UNIQUE),
        )
        op.create_index(CASHIER_INDEX, CASHIER_TABLE, ["store_id"])


def downgrade() -> None:
    insp = _inspector()
    if CASHIER_TABLE in insp.get_table_names():
        op.drop_index(CASHIER_INDEX, table_name=CASHIER_TABLE)
        op.drop_table(CASHIER_TABLE)
    have = {c["name"] for c in insp.get_columns(TRANSACTION_TABLE)}
    if DETAIL_COLUMN[0] in have:
        with op.batch_alter_table(TRANSACTION_TABLE) as batch:
            batch.drop_column(DETAIL_COLUMN[0])
