"""PosImport — every item sold, one row per register line (the
Transactions page's Items view).

Modisoft's item-level transaction report, built on the register's own
lines: when each item sold, on which ticket, its scan code and
department, the quantity, what it sold at against its regular price,
and — when the store's price book holds a cost for that scan code —
the cost and the margin.

Read-only, and the same money rules as the ticket list
(``transactions.py``):

* Only tickets that count are listed (``counts_toward_sales``: sales
  and refunds, minus a fuel prepay deposit its completion restated),
  so the totals here agree with the day's books.
* A voided line is never summed. The default view lists the lines that
  sold; "voided" lists the lines the cashiers cancelled instead, at the
  price they rang (a cancelled line carries no amount).

Passport's prices on an item line: ``RegularSellPrice`` is ONE unit's
shelf price, while ``ActualSalesPrice`` is the WHOLE line's amount
(two tacos: regular $3.49, actual $6.98 — all 18,936 lines with a
quantity of two or more in both sample stores). So the unit a line
sold at is amount / quantity, and a line sold below its regular price
is one whose amount is under regular × quantity.
"""
from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session

from api.Core.Money import to_dollars
from api.Core.Sorting import order_by_slug
from api.Modules.Catalog.Models import PriceBookItem
from api.Modules.PosImport.Models import PosTransaction, PosTransactionLine
from api.Modules.PosImport.Services.naxml import (
    LINE_STATUS_CANCEL, LINE_STATUS_NORMAL,
)
from api.Modules.PosImport.Services.transactions import (
    MAX_PER_PAGE, MAX_RANGE_DAYS, TransactionQueryError, cashier_names,
    counts_toward_sales, department_names, register_stamp, store_timezone,
)

# The Items view's "Show" filter.
SHOW_BELOW_REGULAR = "below_regular"
SHOW_DEPARTMENT_KEY = "department_key"
SHOW_VOIDED = "voided"
SHOWS = (SHOW_BELOW_REGULAR, SHOW_DEPARTMENT_KEY, SHOW_VOIDED)

# Half a cent: a line rings in whole cents, so "below regular" means
# at least a cent under regular × quantity.
_HALF_CENT = 0.5


def _event_time() -> Any:
    return func.coalesce(PosTransaction.receipt_at, PosTransaction.started_at)


def _below_regular() -> Any:
    """Sold under its shelf price: an override, or a deal (2 for $6)."""
    return and_(
        PosTransactionLine.is_fuel.is_(False),
        PosTransactionLine.regular_price_cents > 0,
        PosTransactionLine.amount_cents != 0,
        func.abs(PosTransactionLine.amount_cents)
        < PosTransactionLine.regular_price_cents * PosTransactionLine.quantity
        - _HALF_CENT,
    )


def _department_key() -> Any:
    """Rung on a department key, never scanned: no scan code, not fuel."""
    return and_(
        PosTransactionLine.pos_code == "",
        PosTransactionLine.is_fuel.is_(False),
    )


SORTS: dict[str, Any] = {
    "time": _event_time(),
    "description": func.lower(PosTransactionLine.description),
    "qty": PosTransactionLine.quantity,
    "amount": PosTransactionLine.amount_cents,
}


def list_transaction_lines(
    db: Session, store_id: int, start: date, end: date, *,
    q: str = "", department: str = "", show: str = "",
    sort: str = "", direction: str = "desc",
    page: int = 1, per_page: int = 50,
) -> dict[str, Any]:
    """One page of item lines, newest first by default, with totals
    for the WHOLE filtered set (count, quantity, amount, and the cost
    and margin over the lines whose cost the price book knows)."""
    if end < start:
        raise TransactionQueryError("end must not be before start.")
    if (end - start).days > MAX_RANGE_DAYS:
        raise TransactionQueryError(
            f"Range is limited to {MAX_RANGE_DAYS} days.",
        )
    if show and show not in SHOWS:
        raise TransactionQueryError(f"Unknown show: {show}.")
    per_page = max(1, min(int(per_page or 50), MAX_PER_PAGE))
    page = max(1, int(page or 1))

    cost = PriceBookItem.cost_cents
    query = (
        db.query(PosTransactionLine, PosTransaction, cost)
        .join(PosTransaction, PosTransaction.id == PosTransactionLine.transaction_id)
        .outerjoin(PriceBookItem, and_(
            PriceBookItem.store_id == PosTransactionLine.store_id,
            PriceBookItem.pos_code == PosTransactionLine.pos_code,
            PosTransactionLine.pos_code != "",
        ))
        .filter(
            PosTransactionLine.store_id == store_id,
            PosTransactionLine.business_date >= start,
            PosTransactionLine.business_date <= end,
            counts_toward_sales(),
            PosTransactionLine.status == (
                LINE_STATUS_CANCEL if show == SHOW_VOIDED else LINE_STATUS_NORMAL
            ),
        )
    )
    if department:
        query = query.filter(PosTransactionLine.merchandise_code == department)
    if show == SHOW_BELOW_REGULAR:
        query = query.filter(_below_regular())
    elif show == SHOW_DEPARTMENT_KEY:
        query = query.filter(_department_key())
    needle = q.strip()
    if needle:
        query = query.filter(
            func.lower(PosTransactionLine.description).contains(needle.lower())
            | PosTransactionLine.pos_code.contains(needle),
        )

    # Cost × quantity, only where the price book holds a cost.
    known_cost = and_(cost.isnot(None), cost > 0)
    line_cost = case(
        (known_cost, cost * PosTransactionLine.quantity), else_=0,
    )
    # Units and gallons apart: adding fuel's gallons to items' units
    # would make a number that means nothing.
    fuel = PosTransactionLine.is_fuel.is_(True)
    totals = query.with_entities(
        func.count(PosTransactionLine.id),
        func.coalesce(func.sum(case((fuel, 0.0), else_=PosTransactionLine.quantity)), 0.0),
        func.coalesce(func.sum(case((fuel, PosTransactionLine.gallons), else_=0.0)), 0.0),
        func.coalesce(func.sum(PosTransactionLine.amount_cents), 0),
        func.coalesce(func.sum(line_cost), 0),
        func.coalesce(func.sum(case(
            (known_cost, PosTransactionLine.amount_cents), else_=0,
        )), 0),
    ).one()
    total, qty, gallons, amount_cents, cost_cents, costed_amount_cents = totals
    total = int(total or 0)

    ordered = order_by_slug(
        query, SORTS, sort, direction,
        default=(
            PosTransactionLine.business_date.desc(), _event_time().desc(),
            PosTransactionLine.id.desc(),
        ),
        tiebreak=(PosTransactionLine.id.desc(),),
    )
    rows = ordered.offset((page - 1) * per_page).limit(per_page).all()

    tz = store_timezone(db, store_id)
    names = cashier_names(db, store_id)
    departments = department_names(db, store_id)
    return {
        "rows": [
            _row(line, txn, unit_cost, tz, names, departments)
            for line, txn, unit_cost in rows
        ],
        "total": total,
        "page": page,
        "total_pages": max(1, (total + per_page - 1) // per_page),
        "total_quantity": round(float(qty or 0.0), 3),
        "total_gallons": round(float(gallons or 0.0), 3),
        "total_amount": to_dollars(int(amount_cents or 0)),
        "total_cost": to_dollars(int(round(float(cost_cents or 0)))),
        "costed_amount": to_dollars(int(costed_amount_cents or 0)),
        "departments": [
            {"code": code, "name": name}
            for code, name in sorted(
                departments.items(), key=lambda kv: (kv[1].lower(), kv[0]),
            )
        ],
    }


def _row(
    line: PosTransactionLine, txn: PosTransaction, unit_cost: Any,
    tz: str, names: dict[str, str], departments: dict[str, str],
) -> dict[str, Any]:
    qty = float(line.quantity or 0.0)
    amount = int(line.amount_cents or 0)
    regular = int(line.regular_price_cents or 0)
    cancelled = line.status == LINE_STATUS_CANCEL
    divisor = qty if qty else 1.0
    # A cancelled line carries no amount: it rang at its regular price.
    unit = regular if cancelled else abs(amount) / divisor
    cost_cents = int(unit_cost or 0)
    line_cost = round(cost_cents * qty) if cost_cents > 0 and not cancelled else None
    margin = None
    if line_cost is not None and amount:
        margin = round((amount - line_cost) / amount * 100, 2)
    return {
        "id": line.id,
        "transaction_id": txn.id,
        "transaction_no": txn.transaction_no or "",
        "business_date": line.business_date.isoformat(),
        "at": register_stamp(txn.receipt_at or txn.started_at, tz),
        "kind": txn.kind or "",
        "register_id": txn.register_id or "",
        "cashier_id": txn.cashier_id or "",
        "cashier_name": names.get(txn.cashier_id or "", ""),
        "status": line.status or LINE_STATUS_NORMAL,
        "pos_code": line.pos_code or "",
        "description": line.description or "",
        "merchandise_code": line.merchandise_code or "",
        "department_name": departments.get(line.merchandise_code or "", ""),
        "quantity": round(qty, 3),
        "amount": to_dollars(amount),
        "unit_price": round(unit / 100.0, 2),
        "regular_price": to_dollars(regular),
        "below_regular": (
            not cancelled and not line.is_fuel and regular > 0 and amount != 0
            and abs(amount) < regular * qty - _HALF_CENT
        ),
        "is_fuel": bool(line.is_fuel),
        "gallons": round(float(line.gallons or 0.0), 3),
        "cost": to_dollars(line_cost) if line_cost is not None else None,
        "margin_pct": margin,
    }


__all__ = [
    "SHOWS", "SHOW_BELOW_REGULAR", "SHOW_DEPARTMENT_KEY", "SHOW_VOIDED",
    "SORTS", "list_transaction_lines",
]
