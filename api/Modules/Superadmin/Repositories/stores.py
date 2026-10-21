"""Store SQL helpers for superadmin platform-level endpoints.

The superadmin frequently looks up stores by id, slug, or in bulk.
These helpers wrap the most common patterns. Note: ``db.get(Store, id)``
is already a one-liner — we only re-export when the wrapper adds
context (e.g., ordering, plan-filtering, name-only fetch).
"""
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Query, Session

from api.Core.Sorting import order_by_slug
from api.Modules.Tenancy.Models import Store

# Column slugs the stores list sorts by (``?sort=``); anything else =
# newest store first.
STORE_SORT_COLUMNS: dict[str, Any] = {
    "name":    Store.name,
    "plan":    Store.plan,
    "status":  Store.is_active,
    "created": Store.created_at,
}


def list_all_stores(db: Session) -> list[Store]:
    """Every store, no filter. Caller decides ordering as needed."""
    return db.query(Store).all()


def list_all_stores_newest_first(db: Session) -> list[Store]:
    """All stores sorted by ``created_at`` desc — the canonical
    superadmin ``/stores`` page order."""
    return db.query(Store).order_by(Store.created_at.desc()).all()


def stores_query(
    db: Session, *, q: str = "", sort: str = "", direction: str = "desc",
) -> "Query[Store]":
    """Every store as a sorted query, optionally narrowed by a search
    over name / slug / email (case-insensitive), for paging."""
    query = db.query(Store)
    needle = q.strip()
    if needle:
        like = f"%{needle}%"
        query = query.filter(or_(
            Store.name.ilike(like), Store.slug.ilike(like), Store.email.ilike(like),
        ))
    return order_by_slug(
        query, STORE_SORT_COLUMNS, sort, direction,
        default=(Store.created_at.desc(), Store.id.desc()),
        tiebreak=(Store.id.desc(),),
    )


def list_stores_by_ids(
    db: Session, store_ids: list[int],
) -> list[Store]:
    """Bulk fetch by id list. Returns ``[]`` for empty input."""
    if not store_ids:
        return []
    return db.query(Store).filter(Store.id.in_(store_ids)).all()


def get_store_by_slug(
    db: Session, slug: str,
) -> Store | None:
    """One store by slug (unique). Used by the create-store flow
    to check slug uniqueness and the slug-based admin login
    fallback."""
    return (
        db.query(Store)
          .filter(Store.slug == slug)
          .one_or_none()
    )


def count_all_stores(db: Session) -> int:
    """Total store count for the dashboard's ``total_stores`` KPI."""
    return db.query(Store).count()
