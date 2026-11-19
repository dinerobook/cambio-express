"""add the universal product catalog (retail_product)

One row per GTIN, shared by every store: when a store scans or imports
a barcode another store already has, the name, brand, size and NACS
category fill in by themselves. Price, cost, department, tax and vendor
stay on each store's own ``retail_price_book_item``.

Additive only:
  * new table ``retail_product`` (unique ``gtin``),
  * ``retail_price_book_item.product_id`` (nullable FK, indexed) and
    ``retail_price_book_item.case_discount_cents`` (nullable).
Existing items are linked by the application as they are imported or
saved; nothing is backfilled here (a migration never imports
application code — the barcode rules live in Services/barcodes.py).
``tests/Modules/Catalog/test_universal_products.py`` asserts the
columns match the models. Idempotent both ways.

Revision ID: c6d2e8a4f1b7
Revises: d4f8b2c6e1a3
Create Date: 2026-11-19 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c6d2e8a4f1b7'
down_revision: Union[str, None] = 'd4f8b2c6e1a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


PRODUCT_TABLE = "retail_product"
PRODUCT_COLUMNS: tuple[str, ...] = (
    "id", "gtin", "name", "brand", "size", "nacs_code", "is_verified",
    "source", "created_at", "updated_at",
)
ITEM_TABLE = "retail_price_book_item"
ITEM_ADDED: tuple[str, ...] = ("product_id", "case_discount_cents")
ITEM_INDEX = "ix_retail_price_book_item_product_id"


def _insp() -> sa.engine.reflection.Inspector:
    return sa.inspect(op.get_bind())


def upgrade() -> None:
    insp = _insp()
    if PRODUCT_TABLE not in insp.get_table_names():
        op.create_table(
            PRODUCT_TABLE,
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("gtin", sa.String(length=14), nullable=False),
            sa.Column("name", sa.String(length=160), nullable=False),
            sa.Column("brand", sa.String(length=100), nullable=False, server_default=""),
            sa.Column("size", sa.String(length=40), nullable=False, server_default=""),
            sa.Column("nacs_code", sa.String(length=10), nullable=False, server_default=""),
            sa.Column("is_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("source", sa.String(length=20), nullable=False, server_default=""),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("gtin", name="uq_retail_product_gtin"),
        )
    have = {c["name"] for c in _insp().get_columns(ITEM_TABLE)}
    missing = [c for c in ITEM_ADDED if c not in have]
    if missing:
        with op.batch_alter_table(ITEM_TABLE) as batch:
            if "product_id" in missing:
                batch.add_column(sa.Column(
                    "product_id", sa.Integer(),
                    sa.ForeignKey(
                        "retail_product.id",
                        name="fk_retail_price_book_item_product_id",
                    ),
                    nullable=True,
                ))
            if "case_discount_cents" in missing:
                batch.add_column(sa.Column(
                    "case_discount_cents", sa.BigInteger(), nullable=True,
                ))
    if ITEM_INDEX not in {i["name"] for i in _insp().get_indexes(ITEM_TABLE)}:
        op.create_index(ITEM_INDEX, ITEM_TABLE, ["product_id"])


def downgrade() -> None:
    insp = _insp()
    if ITEM_INDEX in {i["name"] for i in insp.get_indexes(ITEM_TABLE)}:
        op.drop_index(ITEM_INDEX, table_name=ITEM_TABLE)
    have = {c["name"] for c in insp.get_columns(ITEM_TABLE)}
    present = [c for c in ITEM_ADDED if c in have]
    if present:
        with op.batch_alter_table(ITEM_TABLE) as batch:
            if "product_id" in present:
                batch.drop_constraint(
                    "fk_retail_price_book_item_product_id", type_="foreignkey",
                )
            for name in reversed(present):
                batch.drop_column(name)
    if PRODUCT_TABLE in _insp().get_table_names():
        op.drop_table(PRODUCT_TABLE)
