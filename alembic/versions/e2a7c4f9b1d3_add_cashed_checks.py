"""add cashed checks

Check cashing module, PR 2 ("Cash a check"): one row per check brought
to the counter (cashed, not accepted, or voided later), an optional
per-customer daily limit on the store's settings, and the one computer
each store activates for check cashing. The module
is standalone and behind the opt-in ``check_desk`` flag, so nothing
existing reads these.

Additive only: two new tables and one new nullable column. Columns are
spelled out here (a migration never imports application code);
``tests/Modules/CheckCashing/test_check_cashing_migration.py`` asserts
they match the models. Idempotent both ways.

Revision ID: e2a7c4f9b1d3
Revises: d5e8a1c3f7b9
Create Date: 2026-11-09 08:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e2a7c4f9b1d3'
down_revision: Union[str, None] = 'd5e8a1c3f7b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# New columns on existing tables (the test adds them to PR 1's list).
ADDED_COLUMNS: dict[str, tuple[str, ...]] = {
    "msb_check_settings": ("daily_limit_cents",),
}

# New table → its columns, in model order.
TABLES: dict[str, tuple[str, ...]] = {
    "msb_cashed_check": (
        "id", "store_id", "store_day", "customer_id", "company_id",
        "check_number", "check_date", "amount_cents", "fee_kind",
        "fee_value", "fee_suggested_cents", "fee_cents", "cash_cents",
        "micr", "status", "reason", "warnings", "approved_by",
        "created_by", "created_at", "voided_by", "voided_at",
        "void_reason",
    ),
    "msb_check_device": (
        "id", "store_id", "name", "token_hash", "created_by", "created_at",
        "last_seen_at", "revoked_at", "revoked_by",
    ),
}

INDEXES: dict[str, tuple[str, list[str]]] = {
    "ix_msb_cashed_check_store_id": ("msb_cashed_check", ["store_id"]),
    "ix_msb_cashed_check_store_day": ("msb_cashed_check", ["store_day"]),
    "ix_msb_cashed_check_customer_id": ("msb_cashed_check", ["customer_id"]),
    "ix_msb_cashed_check_company_id": ("msb_cashed_check", ["company_id"]),
    "ix_msb_check_device_store_id": ("msb_check_device", ["store_id"]),
}

# Unique indexes (created with unique=True).
UNIQUE_INDEXES: dict[str, tuple[str, list[str]]] = {
    "ix_msb_check_device_token_hash": ("msb_check_device", ["token_hash"]),
}


def _inspector() -> sa.engine.reflection.Inspector:
    return sa.inspect(op.get_bind())


def _user_fk(name: str) -> sa.Column:
    return sa.Column(
        name, sa.Integer(), sa.ForeignKey("tenancy_user.id"), nullable=True,
    )


def upgrade() -> None:
    insp = _inspector()
    tables = set(insp.get_table_names())
    if "msb_check_settings" in tables:
        cols = {c["name"] for c in insp.get_columns("msb_check_settings")}
        if "daily_limit_cents" not in cols:
            with op.batch_alter_table("msb_check_settings") as batch:
                batch.add_column(
                    sa.Column("daily_limit_cents", sa.BigInteger(), nullable=True),
                )
    if "msb_cashed_check" not in tables:
        op.create_table(
            "msb_cashed_check",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"),
                      nullable=False),
            sa.Column("store_day", sa.Date(), nullable=False),
            sa.Column("customer_id", sa.Integer(),
                      sa.ForeignKey("msb_check_customer.id"), nullable=False),
            sa.Column("company_id", sa.Integer(),
                      sa.ForeignKey("msb_check_company.id"), nullable=False),
            sa.Column("check_number", sa.String(length=20), nullable=False,
                      server_default=""),
            sa.Column("check_date", sa.Date(), nullable=True),
            sa.Column("amount_cents", sa.BigInteger(), nullable=False),
            sa.Column("fee_kind", sa.String(length=10), nullable=True),
            sa.Column("fee_value", sa.BigInteger(), nullable=True),
            sa.Column("fee_suggested_cents", sa.BigInteger(), nullable=False,
                      server_default="0"),
            sa.Column("fee_cents", sa.BigInteger(), nullable=False,
                      server_default="0"),
            sa.Column("cash_cents", sa.BigInteger(), nullable=False,
                      server_default="0"),
            sa.Column("micr", sa.String(length=120), nullable=False,
                      server_default=""),
            sa.Column("status", sa.String(length=10), nullable=False,
                      server_default="cashed"),
            sa.Column("reason", sa.String(length=255), nullable=False,
                      server_default=""),
            sa.Column("warnings", sa.String(length=255), nullable=False,
                      server_default=""),
            _user_fk("approved_by"),
            _user_fk("created_by"),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            _user_fk("voided_by"),
            sa.Column("voided_at", sa.DateTime(), nullable=True),
            sa.Column("void_reason", sa.String(length=255), nullable=False,
                      server_default=""),
        )
        for name, (table, cols) in INDEXES.items():
            if table == "msb_cashed_check":
                op.create_index(name, table, cols)
    if "msb_check_device" not in tables:
        op.create_table(
            "msb_check_device",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"),
                      nullable=False),
            sa.Column("name", sa.String(length=60), nullable=False,
                      server_default=""),
            sa.Column("token_hash", sa.String(length=64), nullable=False),
            _user_fk("created_by"),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("last_seen_at", sa.DateTime(), nullable=True),
            sa.Column("revoked_at", sa.DateTime(), nullable=True),
            _user_fk("revoked_by"),
        )
        for name, (table, cols) in INDEXES.items():
            if table == "msb_check_device":
                op.create_index(name, table, cols)
        for name, (table, cols) in UNIQUE_INDEXES.items():
            op.create_index(name, table, cols, unique=True)


def downgrade() -> None:
    insp = _inspector()
    tables = set(insp.get_table_names())
    if "msb_check_device" in tables:
        for name, (table, _cols) in {**INDEXES, **UNIQUE_INDEXES}.items():
            if table == "msb_check_device":
                op.drop_index(name, table_name="msb_check_device")
        op.drop_table("msb_check_device")
    if "msb_cashed_check" in tables:
        for name, (table, _cols) in INDEXES.items():
            if table == "msb_cashed_check":
                op.drop_index(name, table_name="msb_cashed_check")
        op.drop_table("msb_cashed_check")
    if "msb_check_settings" in tables:
        cols = {c["name"] for c in insp.get_columns("msb_check_settings")}
        if "daily_limit_cents" in cols:
            with op.batch_alter_table("msb_check_settings") as batch:
                batch.drop_column("daily_limit_cents")
