"""add returned check batches

Returned checks: a batch groups the checks the bank sent back
together (one return notice), and each check can carry the routing and
account number printed on it, so returns can be tracked by date, by
company and by customer.

Additive only: one new table and three nullable columns on
``msb_return_check``. Every existing check keeps ``batch_id`` NULL and
reads exactly as before. Columns are spelled out here (a migration
never imports application code);
``tests/Modules/ReturnChecks/test_return_check_batch_migration.py``
asserts they match the models. Idempotent both ways.

Revision ID: c8e2f4a6b1d9
Revises: b7e4d2a9c3f1
Create Date: 2026-11-14 06:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c8e2f4a6b1d9'
down_revision: Union[str, None] = 'b7e4d2a9c3f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLES: dict[str, tuple[str, ...]] = {
    "msb_return_check_batch": (
        "id", "store_id", "returned_on", "reference", "notes",
        "created_by", "created_at", "updated_at",
    ),
}

ADDED_COLUMNS: dict[str, tuple[str, ...]] = {
    "msb_return_check": ("batch_id", "routing_number", "account_number"),
}

INDEXES: dict[str, tuple[str, list[str]]] = {
    "ix_msb_return_check_batch_store_id": ("msb_return_check_batch", ["store_id"]),
    "ix_msb_return_check_batch_id": ("msb_return_check", ["batch_id"]),
}

FK_NAME = "fk_msb_return_check_batch_id"


def _inspector() -> sa.engine.reflection.Inspector:
    return sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _inspector()
    tables = set(insp.get_table_names())
    if "msb_return_check_batch" not in tables:
        op.create_table(
            "msb_return_check_batch",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"),
                      nullable=False),
            sa.Column("returned_on", sa.Date(), nullable=False),
            sa.Column("reference", sa.String(length=80), nullable=False,
                      server_default=""),
            sa.Column("notes", sa.Text(), nullable=False, server_default=""),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey("tenancy_user.id"),
                      nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
        op.create_index(
            "ix_msb_return_check_batch_store_id", "msb_return_check_batch",
            ["store_id"],
        )
    if "msb_return_check" in tables:
        cols = {c["name"] for c in insp.get_columns("msb_return_check")}
        if "batch_id" not in cols:
            with op.batch_alter_table("msb_return_check") as batch:
                batch.add_column(sa.Column("batch_id", sa.Integer(), nullable=True))
                batch.add_column(
                    sa.Column("routing_number", sa.String(length=9), nullable=True),
                )
                batch.add_column(
                    sa.Column("account_number", sa.String(length=20), nullable=True),
                )
                batch.create_foreign_key(
                    FK_NAME, "msb_return_check_batch", ["batch_id"], ["id"],
                )
                batch.create_index("ix_msb_return_check_batch_id", ["batch_id"])


def downgrade() -> None:
    insp = _inspector()
    tables = set(insp.get_table_names())
    if "msb_return_check" in tables:
        cols = {c["name"] for c in insp.get_columns("msb_return_check")}
        if "batch_id" in cols:
            with op.batch_alter_table("msb_return_check") as batch:
                batch.drop_index("ix_msb_return_check_batch_id")
                batch.drop_constraint(FK_NAME, type_="foreignkey")
                batch.drop_column("account_number")
                batch.drop_column("routing_number")
                batch.drop_column("batch_id")
    if "msb_return_check_batch" in tables:
        op.drop_index(
            "ix_msb_return_check_batch_store_id",
            table_name="msb_return_check_batch",
        )
        op.drop_table("msb_return_check_batch")
