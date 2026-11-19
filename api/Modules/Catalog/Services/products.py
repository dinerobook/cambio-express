"""The universal product catalog (``retail_product``).

Every store keeps its own price-book item (price, cost, department,
tax, vendor). When the item's scan code is a real GTIN it also points
at one shared ``Product`` row, so the next store that scans the same
barcode gets the name and size filled in.

Rules (the reasons are in ``Models.Product`` and ``barcodes.py``):

* Only codes ``normalize_scan_code`` calls a GTIN are shared. PLUs and
  doubtful codes stay the store's own and never link.
* The first store to bring a GTIN names it; later stores never
  overwrite the shared name (their own wording stays on their item).
* An item with no real name (an import row without a description gets
  a stand-in like "Item 0123") never creates a product — it only links
  to one that already exists.
* Nothing here reads or returns another store's price, cost or item.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, cast

from sqlalchemy import Table, insert as sa_insert
from sqlalchemy.orm import Session

from api.Modules.Catalog.Models import PriceBookItem, Product
from api.Modules.Catalog.Services.barcodes import ScanCode, normalize_scan_code

NAME_MAX = 160
SIZE_MAX = 40
# How many GTINs one IN (...) query carries.
_CHUNK = 500


@dataclass(frozen=True)
class ProductSeed:
    gtin: str
    name: str
    size: str = ""


def _chunks(values: list[str]) -> Iterable[list[str]]:
    for i in range(0, len(values), _CHUNK):
        yield values[i:i + _CHUNK]


def products_by_gtin(db: Session, gtins: Iterable[str]) -> dict[str, Product]:
    wanted = sorted({g for g in gtins if g})
    found: dict[str, Product] = {}
    for part in _chunks(wanted):
        for p in db.query(Product).filter(Product.gtin.in_(part)).all():
            found[str(p.gtin)] = p
    return found


def _insert_ignoring_existing(
    db: Session, rows: list[dict[str, Any]],
) -> None:
    """INSERT the rows, skipping any GTIN another request created in
    the meantime (two stores importing the same file at once)."""
    if not rows:
        return
    dialect = db.get_bind().dialect.name
    table = cast(Table, Product.__table__)
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as pg_insert
        db.execute(
            pg_insert(table).on_conflict_do_nothing(index_elements=["gtin"]),
            rows,
        )
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert
        db.execute(
            sqlite_insert(table).on_conflict_do_nothing(index_elements=["gtin"]),
            rows,
        )
    else:  # pragma: no cover — prod is Postgres, tests SQLite
        db.execute(sa_insert(table), rows)


def ensure_products(
    db: Session, seeds: Iterable[ProductSeed], *, source: str,
) -> tuple[dict[str, Product], int]:
    """Product rows for every seed's GTIN, creating the missing ones.
    Returns ``(gtin → Product, how many were created)``. Existing rows
    are never changed."""
    by_gtin: dict[str, ProductSeed] = {}
    for s in seeds:
        name = s.name.strip()[:NAME_MAX]
        if s.gtin and name and s.gtin not in by_gtin:
            by_gtin[s.gtin] = ProductSeed(s.gtin, name, s.size.strip()[:SIZE_MAX])
    have = products_by_gtin(db, by_gtin)
    missing = [
        {"gtin": g, "name": s.name, "size": s.size, "source": source[:20]}
        for g, s in by_gtin.items() if g not in have
    ]
    if missing:
        db.flush()
        _insert_ignoring_existing(db, missing)
        have.update(products_by_gtin(db, [str(m["gtin"]) for m in missing]))
    return have, len(missing)


def link_item(
    db: Session, item: PriceBookItem, *, source: str, named: bool = True,
) -> ScanCode:
    """Point ``item.product_id`` at the shared product for its scan
    code (creating the product when the item has a real name), or clear
    it for a store code. Returns the normalized code."""
    code = normalize_scan_code(item.pos_code)
    if code.gtin is None:
        item.product_id = None
        return code
    if named:
        products, _ = ensure_products(
            db,
            [ProductSeed(code.gtin, str(item.name or ""), str(item.size or ""))],
            source=source,
        )
    else:
        products = products_by_gtin(db, [code.gtin])
    product = products.get(code.gtin)
    item.product_id = product.id if product is not None else None
    return code


@dataclass(frozen=True)
class ScanLookup:
    code: ScanCode
    # This store's own item for the code (same spelling, or another
    # spelling of the same GTIN). None when the store does not sell it.
    item: PriceBookItem | None
    # The shared product, when the code is a GTIN someone has named.
    product: Product | None


def lookup_scan_code(db: Session, store_id: int, raw: str) -> ScanLookup:
    """What the price book knows about a scanned code. Read-only."""
    code = normalize_scan_code(raw)
    product = (
        db.query(Product).filter(Product.gtin == code.gtin).first()
        if code.gtin else None
    )
    item = None
    if code.kind != "invalid":
        item = (
            db.query(PriceBookItem)
              .filter_by(store_id=store_id, pos_code=code.raw)
              .first()
        )
    if item is None and product is not None:
        item = (
            db.query(PriceBookItem)
              .filter_by(store_id=store_id, product_id=product.id)
              .order_by(PriceBookItem.id)
              .first()
        )
    return ScanLookup(code=code, item=item, product=product)


__all__ = [
    "ProductSeed", "ScanLookup", "ensure_products", "link_item",
    "lookup_scan_code", "products_by_gtin",
]
