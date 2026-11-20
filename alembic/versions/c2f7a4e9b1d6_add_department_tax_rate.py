"""add a department's own tax rate (Account → Departments)

The owner asked for a "Tax rate (%)" box under "Taxable" on the
department form: a store's departments can be taxed at different rates
(groceries lower than general merchandise in many states), so a taxable
department may carry its own rate. Stored as a fraction (0.0825 =
8.25 %), like ``tenancy_store.sales_tax_rate``.

Additive only: one nullable column. Existing departments read as "no
rate set", the box starts empty (the owner's call: not prefilled from
the store's rate). The column is spelled out (a migration never imports
application code); ``tests/Modules/DayClose/test_department_tax_rate.py``
asserts it matches the model. Idempotent both ways.

Revision ID: c2f7a4e9b1d6
Revises: b9e5c3a7d1f4
Create Date: 2026-11-20 00:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c2f7a4e9b1d6'
down_revision: Union[str, None] = 'b9e5c3a7d1f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "retail_department"

# (name, type, nullable, server default)
ADDED: tuple[tuple[str, sa.types.TypeEngine, bool, object], ...] = (  # type: ignore[type-arg]
    ("tax_rate", sa.Float(), True, None),
)

ADDED_COLUMNS: tuple[str, ...] = tuple(name for name, *_rest in ADDED)


def _have() -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    missing = [c for c in ADDED if c[0] not in _have()]
    if not missing:
        return
    with op.batch_alter_table(TABLE) as batch:
        for name, type_, nullable, default in missing:
            batch.add_column(sa.Column(
                name, type_, nullable=nullable, server_default=default,
            ))


def downgrade() -> None:
    present = [name for name in ADDED_COLUMNS if name in _have()]
    if not present:
        return
    with op.batch_alter_table(TABLE) as batch:
        for name in reversed(present):
            batch.drop_column(name)
