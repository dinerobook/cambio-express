"""add currency transaction reports to check cashing

Check cashing PR 6a ("CTR"): what a Currency Transaction Report needs
about the customer (SSN / ITIN encrypted, occupation, full address)
and the store (legal name, EIN, address, contact, the Southwest Border
order switch), plus one row per report. The module is standalone and
behind the opt-in ``check_desk`` flag, so nothing existing reads these.

Additive only: new columns with server defaults and one new table.
Columns are spelled out here (a migration never imports application
code); ``tests/Modules/CheckCashing/test_check_cashing_migration.py``
asserts they match the models. Idempotent both ways.

Revision ID: d4f8b2c6e1a3
Revises: c8e2f4a6b1d9
Create Date: 2026-11-15 21:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4f8b2c6e1a3'
down_revision: Union[str, None] = 'c8e2f4a6b1d9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Table → its new columns, in model order: (name, type, server default).
ADDED: dict[str, tuple[tuple[str, sa.types.TypeEngine, str], ...]] = {  # type: ignore[type-arg]
    "msb_check_settings": (
        ("legal_name", sa.String(length=150), ""),
        ("ein", sa.String(length=9), ""),
        ("street", sa.String(length=100), ""),
        ("city", sa.String(length=50), ""),
        ("state", sa.String(length=2), ""),
        ("zip_code", sa.String(length=9), ""),
        ("contact_name", sa.String(length=100), ""),
        ("contact_phone", sa.String(length=16), ""),
        ("msb_registration", sa.String(length=30), ""),
        ("gto_enabled", sa.Boolean(), "0"),
    ),
    "msb_check_customer": (
        ("tin_type", sa.String(length=10), ""),
        ("tin_encrypted", sa.Text(), ""),
        ("tin_last4", sa.String(length=4), ""),
        ("occupation", sa.String(length=50), ""),
        ("city", sa.String(length=50), ""),
        ("state", sa.String(length=3), ""),
        ("zip_code", sa.String(length=9), ""),
        ("country", sa.String(length=2), "US"),
        ("gender", sa.String(length=10), ""),
    ),
}

ADDED_COLUMNS: dict[str, tuple[str, ...]] = {
    table: tuple(name for name, _type, _default in cols)
    for table, cols in ADDED.items()
}

TABLES: dict[str, tuple[str, ...]] = {
    "msb_check_ctr": (
        "id", "store_id", "customer_id", "store_day", "ein", "kind",
        "cash_cents", "check_count", "status", "due_on", "bsa_id",
        "filed_on", "filed_by", "created_at", "updated_at",
    ),
}

INDEXES: dict[str, tuple[str, list[str]]] = {
    "ix_msb_check_ctr_store_id": ("msb_check_ctr", ["store_id"]),
    "ix_msb_check_ctr_customer_id": ("msb_check_ctr", ["customer_id"]),
    "ix_msb_check_ctr_store_day": ("msb_check_ctr", ["store_day"]),
    "ix_msb_check_ctr_status": ("msb_check_ctr", ["status"]),
}


def _inspector() -> sa.engine.reflection.Inspector:
    return sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _inspector()
    for table, cols in ADDED.items():
        have = {c["name"] for c in insp.get_columns(table)}
        missing = [c for c in cols if c[0] not in have]
        if missing:
            with op.batch_alter_table(table) as batch:
                for name, type_, default in missing:
                    batch.add_column(sa.Column(
                        name, type_, nullable=False,
                        # ``false()`` renders FALSE on Postgres, 0 on SQLite.
                        server_default=sa.false() if isinstance(type_, sa.Boolean)
                        else default,
                    ))
    if "msb_check_ctr" not in insp.get_table_names():
        op.create_table(
            "msb_check_ctr",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"),
                      nullable=False),
            sa.Column("customer_id", sa.Integer(),
                      sa.ForeignKey("msb_check_customer.id"), nullable=False),
            sa.Column("store_day", sa.Date(), nullable=False),
            sa.Column("ein", sa.String(length=9), nullable=False, server_default=""),
            sa.Column("kind", sa.String(length=4), nullable=False,
                      server_default="ctr"),
            sa.Column("cash_cents", sa.BigInteger(), nullable=False,
                      server_default="0"),
            sa.Column("check_count", sa.Integer(), nullable=False,
                      server_default="0"),
            sa.Column("status", sa.String(length=12), nullable=False,
                      server_default="to_file"),
            sa.Column("due_on", sa.Date(), nullable=False),
            sa.Column("bsa_id", sa.String(length=14), nullable=False,
                      server_default=""),
            sa.Column("filed_on", sa.Date(), nullable=True),
            sa.Column("filed_by", sa.Integer(), sa.ForeignKey("tenancy_user.id"),
                      nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("customer_id", "store_day", "ein",
                                name="uq_msb_check_ctr_day"),
        )
        for name, (table, cols) in INDEXES.items():
            op.create_index(name, table, cols)


def downgrade() -> None:
    insp = _inspector()
    if "msb_check_ctr" in insp.get_table_names():
        for name, (table, _cols) in INDEXES.items():
            op.drop_index(name, table_name=table)
        op.drop_table("msb_check_ctr")
    for table, cols in ADDED.items():
        have = {c["name"] for c in insp.get_columns(table)}
        present = [name for name, _t, _d in cols if name in have]
        if present:
            with op.batch_alter_table(table) as batch:
                for name in reversed(present):
                    batch.drop_column(name)
