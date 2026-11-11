"""add check pictures

Check cashing module, PR 3 ("Pictures"): pictures of a check's front and
back, of a customer's ID and of the customer. The server re-encodes each
one and keeps the bytes in the row for the pilot. The module is
standalone and behind the opt-in ``check_desk`` flag, so nothing
existing reads this table.

Additive only: one new table. Columns are spelled out here (a migration
never imports application code);
``tests/Modules/CheckCashing/test_check_cashing_migration.py`` asserts
they match the model. Idempotent both ways.

Revision ID: a3d9f2c6e8b1
Revises: e2a7c4f9b1d3
Create Date: 2026-11-10 23:50:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3d9f2c6e8b1'
down_revision: Union[str, None] = 'e2a7c4f9b1d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


ADDED_COLUMNS: dict[str, tuple[str, ...]] = {}

TABLES: dict[str, tuple[str, ...]] = {
    "msb_check_picture": (
        "id", "store_id", "kind", "cashed_check_id", "customer_id",
        "customer_id_doc_id", "mime", "width", "height", "size_bytes",
        "sha256", "data", "created_by", "created_at", "replaced_at",
    ),
}

INDEXES: dict[str, tuple[str, list[str]]] = {
    "ix_msb_check_picture_store_id": ("msb_check_picture", ["store_id"]),
    "ix_msb_check_picture_cashed_check_id": ("msb_check_picture", ["cashed_check_id"]),
    "ix_msb_check_picture_customer_id": ("msb_check_picture", ["customer_id"]),
    "ix_msb_check_picture_customer_id_doc_id": (
        "msb_check_picture", ["customer_id_doc_id"],
    ),
}


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "msb_check_picture" in tables:
        return
    op.create_table(
        "msb_check_picture",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("tenancy_store.id"),
                  nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("cashed_check_id", sa.Integer(),
                  sa.ForeignKey("msb_cashed_check.id"), nullable=True),
        sa.Column("customer_id", sa.Integer(),
                  sa.ForeignKey("msb_check_customer.id"), nullable=True),
        sa.Column("customer_id_doc_id", sa.Integer(),
                  sa.ForeignKey("msb_check_customer_id.id"), nullable=True),
        sa.Column("mime", sa.String(length=20), nullable=False,
                  server_default="image/jpeg"),
        sa.Column("width", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("height", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sha256", sa.String(length=64), nullable=False,
                  server_default=""),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("tenancy_user.id"),
                  nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("replaced_at", sa.DateTime(), nullable=True),
    )
    for name, (table, cols) in INDEXES.items():
        op.create_index(name, table, cols)


def downgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "msb_check_picture" not in tables:
        return
    for name in INDEXES:
        op.drop_index(name, table_name="msb_check_picture")
    op.drop_table("msb_check_picture")
