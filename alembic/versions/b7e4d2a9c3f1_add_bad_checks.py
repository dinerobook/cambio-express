"""add bad checks

Check cashing module, PR 5 ("Bad checks"): a cashed check the bank
sent back (no funds, closed account, stopped, fraud), what the customer
owes for it, and the money they bring back. The module is standalone
and behind the opt-in ``check_desk`` flag, so nothing existing reads
these tables.

Additive only: two new tables. Columns are spelled out here (a
migration never imports application code);
``tests/Modules/CheckCashing/test_check_cashing_migration.py`` asserts
they match the models. Idempotent both ways.

Revision ID: b7e4d2a9c3f1
Revises: a3d9f2c6e8b1
Create Date: 2026-11-11 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7e4d2a9c3f1'
down_revision: Union[str, None] = 'a3d9f2c6e8b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


ADDED_COLUMNS: dict[str, tuple[str, ...]] = {}

TABLES: dict[str, tuple[str, ...]] = {
    "msb_bad_check": (
        "id", "store_id", "cashed_check_id", "reason", "returned_on",
        "fee_cents", "owed_cents", "paid_cents", "status", "note",
        "created_by", "created_at", "closed_at", "written_off_by",
        "write_off_note",
    ),
    "msb_bad_check_payment": (
        "id", "bad_check_id", "store_id", "paid_on", "amount_cents", "note",
        "created_by", "created_at",
    ),
}

INDEXES: dict[str, tuple[str, list[str]]] = {
    "ix_msb_bad_check_store_id": ("msb_bad_check", ["store_id"]),
    "ix_msb_bad_check_status": ("msb_bad_check", ["status"]),
    "ix_msb_bad_check_payment_store_id": ("msb_bad_check_payment", ["store_id"]),
    "ix_msb_bad_check_payment_bad_check_id": (
        "msb_bad_check_payment", ["bad_check_id"],
    ),
}

UNIQUE_INDEXES: dict[str, tuple[str, list[str]]] = {
    # One bad check per cashed check.
    "ix_msb_bad_check_cashed_check_id": ("msb_bad_check", ["cashed_check_id"]),
}


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    tables = _tables()
    if "msb_bad_check" not in tables:
        op.create_table(
            "msb_bad_check",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"),
                      nullable=False),
            sa.Column("cashed_check_id", sa.Integer(),
                      sa.ForeignKey("msb_cashed_check.id"), nullable=False),
            sa.Column("reason", sa.String(length=20), nullable=False,
                      server_default="nsf"),
            sa.Column("returned_on", sa.Date(), nullable=False),
            sa.Column("fee_cents", sa.BigInteger(), nullable=False,
                      server_default="0"),
            sa.Column("owed_cents", sa.BigInteger(), nullable=False,
                      server_default="0"),
            sa.Column("paid_cents", sa.BigInteger(), nullable=False,
                      server_default="0"),
            sa.Column("status", sa.String(length=12), nullable=False,
                      server_default="open"),
            sa.Column("note", sa.String(length=255), nullable=False,
                      server_default=""),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey("tenancy_user.id"),
                      nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("closed_at", sa.DateTime(), nullable=True),
            sa.Column("written_off_by", sa.Integer(),
                      sa.ForeignKey("tenancy_user.id"), nullable=True),
            sa.Column("write_off_note", sa.String(length=255), nullable=False,
                      server_default=""),
        )
        for name, (table, cols) in INDEXES.items():
            if table == "msb_bad_check":
                op.create_index(name, table, cols)
        for name, (table, cols) in UNIQUE_INDEXES.items():
            op.create_index(name, table, cols, unique=True)
    if "msb_bad_check_payment" not in tables:
        op.create_table(
            "msb_bad_check_payment",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("bad_check_id", sa.Integer(),
                      sa.ForeignKey("msb_bad_check.id"), nullable=False),
            sa.Column("store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"),
                      nullable=False),
            sa.Column("paid_on", sa.Date(), nullable=False),
            sa.Column("amount_cents", sa.BigInteger(), nullable=False),
            sa.Column("note", sa.String(length=255), nullable=False,
                      server_default=""),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey("tenancy_user.id"),
                      nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
        for name, (table, cols) in INDEXES.items():
            if table == "msb_bad_check_payment":
                op.create_index(name, table, cols)


def downgrade() -> None:
    tables = _tables()
    if "msb_bad_check_payment" in tables:
        for name, (table, _cols) in INDEXES.items():
            if table == "msb_bad_check_payment":
                op.drop_index(name, table_name=table)
        op.drop_table("msb_bad_check_payment")
    if "msb_bad_check" in tables:
        for name, (table, _cols) in {**INDEXES, **UNIQUE_INDEXES}.items():
            if table == "msb_bad_check":
                op.drop_index(name, table_name=table)
        op.drop_table("msb_bad_check")
