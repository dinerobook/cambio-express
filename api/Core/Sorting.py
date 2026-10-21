"""Column sorting for list endpoints — one whitelist lookup.

Every sortable list takes ``?sort=<slug>&dir=asc|desc``. The slug
is looked up in the endpoint's own whitelist (``{slug: column}``);
an unknown or empty slug falls back to the list's default order, so
a stale bookmark never 422s. ``tiebreak`` keeps rows with equal
keys in a stable order, so paging never shows a row twice or skips
one.

    from api.Core.Sorting import order_by_slug

    SORT_COLUMNS = {"name": Thing.name, "price": Thing.price_cents}
    q = order_by_slug(
        q, SORT_COLUMNS, sort, direction,
        default=(Thing.name, Thing.id), tiebreak=(Thing.id,),
    )
"""
from __future__ import annotations

from typing import Any, Mapping, Sequence, TypeVar

from sqlalchemy.orm import Query

SORT_DIR_PATTERN = "^(asc|desc)$"

_T = TypeVar("_T")


def order_by_slug(
    query: Query[_T],
    columns: Mapping[str, Any],
    slug: str,
    direction: str,
    *,
    default: Sequence[Any],
    tiebreak: Sequence[Any] = (),
) -> Query[_T]:
    """``query`` ordered by the whitelisted column ``slug`` names (then
    ``tiebreak``), or by ``default`` when the slug is unknown."""
    col = columns.get((slug or "").strip())
    if col is None:
        return query.order_by(*default)
    order = col.asc() if direction == "asc" else col.desc()
    return query.order_by(order, *tiebreak)
