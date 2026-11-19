"""add Gilbarco movement report tables (G-7)

Gilbarco Passport writes six NAXML movement report families beside
the PJR journal: FGM (fuel grades), ISM (items), MCM (departments),
MSM (payouts, drops, statistics), TLM (tax levels) and TPM (tanks,
header only). The import dropped them all. These five tables keep
what the first five report, one row per detail, money in integer
cents. TPM stores nothing.

Every row repeats its report's MovementHeader (the owner's target
schema lays them out that way). The unique constraint is the report
key plus the row's position in the file, so the same report can
never be stored twice; ingest replaces a report's rows when it is
sent again.

Additive only: five new tables, nothing existing changes. They start
empty and fill as the site agent sends movement files; nothing reads
them into a day total. Columns are spelled out here (a migration
never imports application code);
``tests/Modules/PosImport/test_movement_migration.py`` asserts they
match the models. Idempotent both ways.

Revision ID: b9e5c3a7d1f4
Revises: a6c1e9f4b2d7
Create Date: 2026-11-18 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b9e5c3a7d1f4'
down_revision: Union[str, None] = 'a6c1e9f4b2d7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (name, type, nullable, server default)
Spec = tuple[str, sa.types.TypeEngine, bool, Union[str, None]]  # type: ignore[type-arg]

# The MovementHeader every row repeats, after id + store_id.
HEADER: tuple[Spec, ...] = (
    ("source_file", sa.String(length=120), False, None),
    ("report_sequence_number", sa.Integer(), False, "0"),
    ("primary_report_period", sa.Integer(), False, "0"),
    ("secondary_report_period", sa.Integer(), False, "0"),
    ("business_date", sa.Date(), False, None),
    ("begin_date", sa.Date(), False, None),
    ("begin_time", sa.Time(), False, None),
    ("end_date", sa.Date(), True, None),
    ("end_time", sa.Time(), True, None),
    ("detail_seq", sa.Integer(), False, None),
)


def _code(name: str, length: int) -> Spec:
    return (name, sa.String(length=length), False, "")


def _cents(name: str) -> Spec:
    return (name, sa.BigInteger(), False, "0")


def _count(name: str) -> Spec:
    return (name, sa.Integer(), False, "0")


def _volume(name: str) -> Spec:
    return (name, sa.Float(), False, "0")


TABLES: dict[str, tuple[Spec, ...]] = {
    "retail_pos_fuel_grade_movement": (
        _code("fuel_grade_id", 10),
        _code("fuel_position_id", 10),
        _volume("non_resettable_total_volume"),
        _cents("non_resettable_total_amount_cents"),
        _code("price_tier_code", 10),
        _volume("sales_volume"),
        _cents("sales_amount_cents"),
        _cents("pump_test_amount_cents"),
        _volume("pump_test_volume"),
        _volume("tax_exempt_sales_volume"),
        _cents("discount_amount_cents"),
        _count("discount_count"),
        _cents("dispenser_discount_amount_cents"),
        _count("dispenser_discount_count"),
    ),
    "retail_pos_merchandise_code_movement": (
        _code("merchandise_code", 20),
        _code("description", 160),
        _cents("discount_amount_cents"),
        _count("discount_count"),
        _cents("promotion_amount_cents"),
        _count("promotion_count"),
        _cents("refund_amount_cents"),
        _count("refund_count"),
        _volume("sales_quantity"),
        _cents("sales_amount_cents"),
        _count("transaction_count"),
        _cents("open_dept_sales_amount_cents"),
        _count("open_dept_transaction_count"),
    ),
    "retail_pos_item_sales_movement": (
        _code("pos_code_format", 20),
        _code("pos_code", 30),
        _code("pos_code_modifier", 20),
        _code("item_id", 50),
        _code("description", 160),
        _code("merchandise_code", 20),
        _code("selling_units", 20),
        _cents("actual_sales_price_cents"),
        _volume("sales_quantity"),
        _cents("sales_amount_cents"),
        _cents("discount_amount_cents"),
        _count("discount_count"),
        _cents("promotion_amount_cents"),
        _count("promotion_count"),
        _cents("refund_amount_cents"),
        _count("refund_count"),
        _count("transaction_count"),
    ),
    "retail_pos_misc_summary_movement": (
        _code("summary_code", 50),
        _code("summary_sub_code", 50),
        # NULL = the file had no modifier element (a subtotal row).
        ("summary_sub_code_modifier", sa.String(length=50), True, None),
        _code("tender_code", 30),
        _code("tender_sub_code", 30),
        _cents("summary_amount_cents"),
        _volume("summary_count"),
    ),
    "retail_pos_tax_level_movement": (
        _code("tax_level_id", 20),
        _code("merchandise_code", 20),
        _cents("taxable_sales_amount_cents"),
        _cents("taxable_sales_refunded_cents"),
        _cents("tax_collected_amount_cents"),
        _cents("tax_exempt_sales_amount_cents"),
        _cents("tax_exempt_refunded_cents"),
        _cents("tax_forgiven_sales_cents"),
        _cents("tax_forgiven_refunded_cents"),
        _cents("tax_refunded_amount_cents"),
    ),
}

# The report key + row position. Leads with store_id, so it is also
# the index the retention purge and the per-day reads use.
UNIQUE_COLUMNS: tuple[str, ...] = (
    "store_id", "business_date", "begin_date", "begin_time",
    "primary_report_period", "secondary_report_period", "detail_seq",
)


def _unique_name(table: str) -> str:
    return f"uq_{table}_report_row"


def upgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    for table, columns in TABLES.items():
        if table in existing:
            continue
        cols = [
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"),
                nullable=False,
            ),
        ]
        for name, type_, nullable, default in HEADER + columns:
            cols.append(sa.Column(
                name, type_, nullable=nullable, server_default=default,
            ))
        op.create_table(
            table, *cols,
            sa.UniqueConstraint(*UNIQUE_COLUMNS, name=_unique_name(table)),
        )


def downgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    for table in reversed(list(TABLES)):
        if table in existing:
            op.drop_table(table)
