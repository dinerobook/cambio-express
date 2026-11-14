"""Check cashing — the period summary.

What the counter did over a period, for the Checks page's summary and
the view-only report in the back office (owners on their phones):
totals, each store, each day, the busiest companies and customers, and
where bad checks stand. Read only; every day is a store day.

Rules: this module's ``INVARIANTS.md`` ("Checks and reports").
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from api.Modules.CheckCashing.Models import (
    BadCheck, BadCheckPayment, CashedCheck, CheckCompany, CheckCustomer,
)
from api.Modules.CheckCashing.Services.bad_checks import open_bad_checks

TOP = 5


@dataclass
class Totals:
    cashed: int = 0
    amount_cents: int = 0
    fee_cents: int = 0
    cash_cents: int = 0
    declined: int = 0
    voided: int = 0


@dataclass
class Party:
    id: int
    name: str
    cashed: int
    amount_cents: int


@dataclass
class BadCheckTotals:
    open_count: int
    open_owed_cents: int
    returned: int
    returned_cents: int
    paid_back_cents: int


@dataclass
class Summary:
    totals: Totals
    stores: dict[int, Totals] = field(default_factory=dict)
    days: dict[date, Totals] = field(default_factory=dict)
    companies: list[Party] = field(default_factory=list)
    customers: list[Party] = field(default_factory=list)
    bad: BadCheckTotals | None = None


def _sums() -> list[Any]:
    cashed = CashedCheck.status == "cashed"
    return [
        func.sum(case((cashed, 1), else_=0)),
        func.sum(case((cashed, CashedCheck.amount_cents), else_=0)),
        func.sum(case((cashed, CashedCheck.fee_cents), else_=0)),
        func.sum(case((cashed, CashedCheck.cash_cents), else_=0)),
        func.sum(case((CashedCheck.status == "declined", 1), else_=0)),
        func.sum(case((CashedCheck.status == "voided", 1), else_=0)),
    ]


def _totals(row: Any) -> Totals:
    return Totals(*(int(v or 0) for v in row))


def _top(
    db: Session, store_ids: list[int], d_from: date, d_to: date, column: Any,
    model: Any, name: Any,
) -> list[Party]:
    rows = (
        db.query(
            model.id, name, func.count(CashedCheck.id),
            func.sum(CashedCheck.amount_cents),
        )
        .join(CashedCheck, column == model.id)
        .filter(
            CashedCheck.store_id.in_(store_ids), CashedCheck.status == "cashed",
            CashedCheck.store_day.between(d_from, d_to),
        )
        .group_by(model.id, name)
        .order_by(func.sum(CashedCheck.amount_cents).desc(), model.id)
        .limit(TOP)
        .all()
    )
    return [Party(int(i), n or "", int(c), int(a or 0)) for i, n, c, a in rows]


def summary(
    db: Session, store_ids: list[int], d_from: date, d_to: date,
) -> Summary:
    """Totals of ``store_ids`` for the store days ``d_from``–``d_to``."""
    base = db.query(CashedCheck).filter(
        CashedCheck.store_id.in_(store_ids),
        CashedCheck.store_day.between(d_from, d_to),
    )
    out = Summary(totals=_totals(base.with_entities(*_sums()).one()))
    for sid, *rest in (
        base.with_entities(CashedCheck.store_id, *_sums())
        .group_by(CashedCheck.store_id).all()
    ):
        out.stores[int(sid)] = _totals(rest)
    for day, *rest in (
        base.with_entities(CashedCheck.store_day, *_sums())
        .group_by(CashedCheck.store_day).order_by(CashedCheck.store_day.desc()).all()
    ):
        out.days[day] = _totals(rest)
    out.companies = _top(
        db, store_ids, d_from, d_to, CashedCheck.company_id, CheckCompany,
        CheckCompany.name,
    )
    out.customers = _top(
        db, store_ids, d_from, d_to, CashedCheck.customer_id, CheckCustomer,
        CheckCustomer.full_name,
    )
    still_open = open_bad_checks(db, store_ids)
    returned, returned_cents = (
        db.query(func.count(BadCheck.id), func.coalesce(func.sum(BadCheck.owed_cents), 0))
        .filter(
            BadCheck.store_id.in_(store_ids),
            BadCheck.returned_on.between(d_from, d_to),
        ).one()
    )
    paid_back = (
        db.query(func.coalesce(func.sum(BadCheckPayment.amount_cents), 0))
        .filter(
            BadCheckPayment.store_id.in_(store_ids),
            BadCheckPayment.paid_on.between(d_from, d_to),
        ).scalar()
    )
    out.bad = BadCheckTotals(
        open_count=still_open.count, open_owed_cents=still_open.owed_cents,
        returned=int(returned), returned_cents=int(returned_cents),
        paid_back_cents=int(paid_back or 0),
    )
    return out
