"""add department setup fields (Account → Departments)

The owner's department setup, modelled on Modisoft's Setup →
Departments: what kind of sales a department holds (``department_type``
— lottery sales, lotto payouts, money order fees…, which the daily
paperwork will read), whether it is taxable, the minimum buyer age and
the NACS product code. The register's department number is not added
here: it already lives in ``retail_pos_merchandise_map``.

Additive only: four new columns, each nullable or with a server
default, so existing departments read as taxable merchandise with no
age limit. Columns are spelled out (a migration never imports
application code); ``tests/Modules/DayClose/test_department_setup.py``
asserts they match the model. Idempotent both ways.

Revision ID: b3e7c1a9d5f2
Revises: d4f8b2c6e1a3
Create Date: 2026-11-19 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3e7c1a9d5f2'
down_revision: Union[str, None] = 'd4f8b2c6e1a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "retail_department"

# The new columns, in model order: (name, type, nullable, server default).
ADDED: tuple[tuple[str, sa.types.TypeEngine, bool, object], ...] = (  # type: ignore[type-arg]
    ("department_type", sa.String(length=30), False, "merchandise"),
    # ``true()`` renders TRUE on Postgres, 1 on SQLite.
    ("is_taxable", sa.Boolean(), False, sa.true()),
    ("min_age", sa.Integer(), True, None),
    ("nacs_code", sa.String(length=10), False, ""),
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
