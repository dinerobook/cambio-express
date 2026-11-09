"""add check cashing tables

Check cashing module, PR 1 of the plan the owner approved on
2026-11-09: settings, customers (with their ID documents) and
companies. The module is standalone and behind the opt-in
``check_desk`` flag, so nothing existing reads these tables.

Additive only: four new tables, nothing existing is touched. Columns
are spelled out here (a migration never imports application code);
``tests/Modules/CheckCashing/test_check_cashing_migration.py`` asserts
they match the models. Idempotent: each table is created only when it
is missing, and dropped only when present.

Revision ID: d5e8a1c3f7b9
Revises: c9d4e7a2f1b6
Create Date: 2026-11-09 03:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5e8a1c3f7b9'
down_revision: Union[str, None] = 'c9d4e7a2f1b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Table → its columns, in model order (the test compares them).
TABLES: dict[str, tuple[str, ...]] = {
    "msb_check_settings": (
        "id", "store_id", "default_fee_kind", "default_fee_value",
        "base_charge_cents", "base_charge_under_cents", "expired_id_mode",
        "updated_by", "updated_at",
    ),
    "msb_check_customer": (
        "id", "store_id", "full_name", "dob", "phone_country",
        "phone_number", "address", "status", "status_reason", "fee_kind",
        "fee_value", "notes", "created_by", "created_at", "updated_at",
    ),
    "msb_check_customer_id": (
        "id", "store_id", "customer_id", "id_type", "id_number", "issuer",
        "expires_on", "created_at",
    ),
    "msb_check_company": (
        "id", "store_id", "name", "routing_number", "account_number",
        "address", "phone", "status", "status_reason", "fee_kind",
        "fee_value", "notes", "created_by", "created_at", "updated_at",
    ),
}

# Index name → (table, columns). Names follow SQLAlchemy's
# ``index=True`` naming so the models and this file agree.
INDEXES: dict[str, tuple[str, list[str]]] = {
    "ix_msb_check_settings_store_id": ("msb_check_settings", ["store_id"]),
    "ix_msb_check_customer_store_id": ("msb_check_customer", ["store_id"]),
    "ix_msb_check_customer_id_store_id": ("msb_check_customer_id", ["store_id"]),
    "ix_msb_check_customer_id_customer_id": ("msb_check_customer_id", ["customer_id"]),
    "ix_msb_check_company_store_id": ("msb_check_company", ["store_id"]),
    "ix_msb_check_company_routing_number": ("msb_check_company", ["routing_number"]),
}


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _store_fk() -> sa.Column:
    return sa.Column(
        "store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"),
        nullable=False,
    )


def _user_fk(name: str) -> sa.Column:
    return sa.Column(
        name, sa.Integer(), sa.ForeignKey("tenancy_user.id"), nullable=True,
    )


def _party_columns() -> list[sa.Column]:
    """Status, own fee and notes — shared by customers and companies."""
    return [
        sa.Column("status", sa.String(length=10), nullable=False,
                  server_default="normal"),
        sa.Column("status_reason", sa.String(length=255), nullable=False,
                  server_default=""),
        sa.Column("fee_kind", sa.String(length=10), nullable=True),
        sa.Column("fee_value", sa.BigInteger(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        _user_fk("created_by"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    ]


def _create(table: str, *columns: sa.Column) -> None:
    op.create_table(table, *columns)
    for name, (tbl, cols) in INDEXES.items():
        if tbl == table:
            op.create_index(
                name, table, cols, unique=(name == "ix_msb_check_settings_store_id"),
            )


def upgrade() -> None:
    existing = _tables()
    if "msb_check_settings" not in existing:
        _create(
            "msb_check_settings",
            sa.Column("id", sa.Integer(), primary_key=True),
            _store_fk(),
            sa.Column("default_fee_kind", sa.String(length=10), nullable=False,
                      server_default="percent"),
            sa.Column("default_fee_value", sa.BigInteger(), nullable=False,
                      server_default="0"),
            sa.Column("base_charge_cents", sa.BigInteger(), nullable=True),
            sa.Column("base_charge_under_cents", sa.BigInteger(), nullable=True),
            sa.Column("expired_id_mode", sa.String(length=10), nullable=False,
                      server_default="warn"),
            _user_fk("updated_by"),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
    if "msb_check_customer" not in existing:
        _create(
            "msb_check_customer",
            sa.Column("id", sa.Integer(), primary_key=True),
            _store_fk(),
            sa.Column("full_name", sa.String(length=120), nullable=False),
            sa.Column("dob", sa.Date(), nullable=True),
            sa.Column("phone_country", sa.String(length=8), nullable=False,
                      server_default="+1"),
            sa.Column("phone_number", sa.String(length=40), nullable=False,
                      server_default=""),
            sa.Column("address", sa.String(length=255), nullable=False,
                      server_default=""),
            *_party_columns(),
        )
    if "msb_check_customer_id" not in existing:
        _create(
            "msb_check_customer_id",
            sa.Column("id", sa.Integer(), primary_key=True),
            _store_fk(),
            sa.Column("customer_id", sa.Integer(),
                      sa.ForeignKey("msb_check_customer.id"), nullable=False),
            sa.Column("id_type", sa.String(length=20), nullable=False),
            sa.Column("id_number", sa.String(length=60), nullable=False),
            sa.Column("issuer", sa.String(length=60), nullable=False,
                      server_default=""),
            sa.Column("expires_on", sa.Date(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
    if "msb_check_company" not in existing:
        _create(
            "msb_check_company",
            sa.Column("id", sa.Integer(), primary_key=True),
            _store_fk(),
            sa.Column("name", sa.String(length=160), nullable=False),
            sa.Column("routing_number", sa.String(length=9), nullable=False,
                      server_default=""),
            sa.Column("account_number", sa.String(length=20), nullable=False,
                      server_default=""),
            sa.Column("address", sa.String(length=255), nullable=False,
                      server_default=""),
            sa.Column("phone", sa.String(length=40), nullable=False,
                      server_default=""),
            *_party_columns(),
        )


def downgrade() -> None:
    existing = _tables()
    # Children first: customer IDs point at customers.
    for table in (
        "msb_check_customer_id", "msb_check_customer",
        "msb_check_company", "msb_check_settings",
    ):
        if table not in existing:
            continue
        for name, (tbl, _cols) in INDEXES.items():
            if tbl == table:
                op.drop_index(name, table_name=table)
        op.drop_table(table)
