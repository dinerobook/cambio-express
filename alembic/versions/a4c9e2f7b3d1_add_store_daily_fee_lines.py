"""add the money order fee and money transfer fee lines to the store daily book

The register's day close reports a store's money order fees and money
transfer fees as their own departments, and the fee is the store's
income while the money order or transfer itself is not. The store
daily book had one line for each service and nowhere to put its fee,
so a day filled from the register could not balance. Two lines are
added beside "Money order" and "Money transfer".

Additive only: two NOT NULL columns with a server default of 0, so
every existing day reads $0.00 on both and no total moves. The columns
are spelled out (a migration never imports application code);
``tests/Modules/StoreBook/test_migration_matches_model.py`` asserts
they match the model. Idempotent both ways.

Revision ID: a4c9e2f7b3d1
Revises: f3b8c1d9e4a7
Create Date: 2026-11-22 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a4c9e2f7b3d1'
down_revision: Union[str, None] = 'f3b8c1d9e4a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "retail_store_daily_entry"

# The new money lines, without the ``_cents`` suffix the columns carry.
_MONEY_FIELDS: tuple[str, ...] = ("money_order_fee", "money_transfer_fee")


def _have() -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    missing = [k for k in _MONEY_FIELDS if f"{k}_cents" not in _have()]
    if not missing:
        return
    with op.batch_alter_table(TABLE) as batch:
        for key in missing:
            batch.add_column(sa.Column(
                f"{key}_cents", sa.BigInteger(),
                nullable=False, server_default="0",
            ))


def downgrade() -> None:
    present = [k for k in _MONEY_FIELDS if f"{k}_cents" in _have()]
    if not present:
        return
    with op.batch_alter_table(TABLE) as batch:
        for key in reversed(present):
            batch.drop_column(f"{key}_cents")
