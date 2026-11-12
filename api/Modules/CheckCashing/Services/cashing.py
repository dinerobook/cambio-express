"""Check cashing — Cash a check.

Works out the fee for a check, the review a cashier sees before paying
(the checks Lytcheck and Emaginet run at the counter), and records the
outcome: cashed, not accepted, or voided later the same store day.

Money is integer cents throughout. Rules live in this module's
``INVARIANTS.md`` ("Cash a check").
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Query, Session

from api.Core.Clock import utc_now
from api.Modules.CheckCashing.Models import (
    CashedCheck, CheckCompany, CheckCustomer,
)
from api.Modules.CheckCashing.Services import (
    CheckCashingConflictError, CheckCashingNotFoundError, get_settings,
    id_expired,
)
from api.Modules.CheckCashing.Services.bad_checks import (
    bad_checks_for, open_bad_checks,
)

# A business that pays out more than this in cash to one person in one
# day files a Currency Transaction Report (FinCEN). Filing it is a later
# PR; for now the review says one is due.
CTR_THRESHOLD_CENTS = 1_000_000
# A check older than this is "stale-dated" (UCC: banks may refuse a
# check over six months old).
STALE_DAYS = 180

# How a review item weighs:
#   info     — shown, nothing to do;
#   warn     — the cashier must tick that they checked it;
#   approve  — a manager (``check_cashing_manage.update``) must approve;
#   block    — cannot be cashed until the cause is fixed.
LEVELS = ("info", "warn", "approve", "block")


@dataclass
class Fee:
    kind: str | None
    value: int | None          # basis points or cents, as stored
    cents: int
    source: str                # customer, company or store
    base_applied: bool


@dataclass
class ReviewItem:
    code: str
    level: str
    count: int | None = None
    amount_cents: int | None = None
    day: date | None = None


@dataclass
class Review:
    fee: Fee | None
    items: list[ReviewItem] = field(default_factory=list)
    today_count: int = 0
    today_cents: int = 0

    def codes(self, *levels: str) -> set[str]:
        return {i.code for i in self.items if i.level in levels}


def percent_of(amount_cents: int, basis_points: int) -> int:
    """``amount × rate``, rounded half up to the cent."""
    return (amount_cents * basis_points + 5_000) // 10_000


def work_out_fee(
    settings: dict[str, Any], customer: CheckCustomer | None,
    company: CheckCompany | None, amount_cents: int,
) -> Fee:
    """The customer's own fee, else the company's, else the store's
    default; then the base charge for a small check. Never more than
    the check."""
    if customer is not None and customer.fee_kind:
        kind, value, source = customer.fee_kind, customer.fee_value or 0, "customer"
    elif company is not None and company.fee_kind:
        kind, value, source = company.fee_kind, company.fee_value or 0, "company"
    else:
        kind = settings["default_fee_kind"]
        value = settings["default_fee_value"] or 0
        source = "store"
    cents = percent_of(amount_cents, value) if kind == "percent" else value
    base = settings.get("base_charge_cents")
    under = settings.get("base_charge_under_cents")
    base_applied = False
    if base and under and amount_cents < under and cents < base:
        cents, base_applied = base, True
    return Fee(kind, value, min(cents, amount_cents), source, base_applied)


def checks_query(db: Session, store_ids: list[int]) -> Query[CashedCheck]:
    return db.query(CashedCheck).filter(CashedCheck.store_id.in_(store_ids))


def _today_for_customer(
    db: Session, store_ids: list[int], customer_id: int, today: date,
) -> tuple[int, int]:
    count, total = (
        checks_query(db, store_ids)
        .filter(
            CashedCheck.customer_id == customer_id,
            CashedCheck.status == "cashed",
            CashedCheck.store_day == today,
        )
        .with_entities(func.count(CashedCheck.id), func.coalesce(func.sum(CashedCheck.amount_cents), 0))
        .one()
    )
    return int(count), int(total)


def review(
    db: Session, store_id: int, store_ids: list[int], *,
    customer: CheckCustomer | None, company: CheckCompany | None,
    check_number: str, check_date: date | None, amount_cents: int,
    today: date,
) -> Review:
    """Everything the cashier should know before paying, worst first
    in ``LEVELS`` order once the SPA sorts it."""
    settings = get_settings(db, store_id)
    fee = (
        work_out_fee(settings, customer, company, amount_cents)
        if amount_cents > 0 else None
    )
    result = Review(fee=fee)
    items = result.items

    if customer is not None:
        if customer.status == "blocked":
            items.append(ReviewItem("customer_blocked", "block"))
        if not customer.ids:
            items.append(ReviewItem("no_id", "block"))
        elif all(id_expired(i, today) for i in customer.ids):
            mode = settings["expired_id_mode"]
            items.append(ReviewItem("id_expired", "block" if mode == "block" else "warn"))
        if customer.status == "trusted":
            items.append(ReviewItem("customer_trusted", "info"))
        count, total = _today_for_customer(db, store_ids, int(customer.id), today)
        result.today_count, result.today_cents = count, total
        if count:
            items.append(ReviewItem("cashed_today", "warn", count=count, amount_cents=total))
        owed = open_bad_checks(db, store_ids, customer_id=int(customer.id))
        if owed.count:
            items.append(ReviewItem(
                "customer_bad_check", "approve", count=owed.count,
                amount_cents=owed.owed_cents,
            ))
        limit = settings.get("daily_limit_cents")
        if limit and total + amount_cents > limit:
            items.append(ReviewItem("daily_limit", "approve", amount_cents=limit))
        if total + amount_cents > CTR_THRESHOLD_CENTS:
            items.append(ReviewItem("ctr_due", "info", amount_cents=total + amount_cents))

    if company is not None:
        if company.status == "blocked":
            items.append(ReviewItem("company_blocked", "block"))
        if company.status == "trusted":
            items.append(ReviewItem("company_trusted", "info"))
        bounced = open_bad_checks(db, store_ids, company_id=int(company.id))
        if bounced.count:
            items.append(ReviewItem(
                "company_bad_check", "approve", count=bounced.count,
                amount_cents=bounced.owed_cents,
            ))
        cashed = checks_query(db, store_ids).filter(
            CashedCheck.company_id == company.id, CashedCheck.status == "cashed",
        )
        number = check_number.strip()
        if number:
            dup = cashed.filter(CashedCheck.check_number == number).order_by(
                CashedCheck.id.desc(),
            ).first()
            if dup is not None:
                items.append(ReviewItem("duplicate", "approve", day=dup.store_day))
        if cashed.first() is None:
            items.append(ReviewItem("first_check", "info"))

    if check_date is not None:
        if check_date > today:
            items.append(ReviewItem("future_dated", "warn", day=check_date))
        elif check_date < today - timedelta(days=STALE_DAYS):
            items.append(ReviewItem("stale_dated", "warn", day=check_date))
    return result


@dataclass
class CashRequest:
    customer_id: int
    company_id: int
    check_number: str
    check_date: date | None
    amount_cents: int
    fee_cents: int
    acknowledged: set[str]
    decision: str                # cash or decline
    reason: str
    micr: str


def record(
    db: Session, store_id: int, store_ids: list[int], req: CashRequest,
    *, user_id: int, can_approve: bool, today: date,
    customer: CheckCustomer, company: CheckCompany,
) -> CashedCheck:
    """Save the outcome. A check is cashed only once every block is
    cleared, every warning ticked and, where one is needed, a manager
    approved; a refusal (``decline``) is always saved."""
    result = review(
        db, store_id, store_ids, customer=customer, company=company,
        check_number=req.check_number, check_date=req.check_date,
        amount_cents=req.amount_cents, today=today,
    )
    row = CashedCheck(
        store_id=store_id, store_day=today,
        customer_id=customer.id, company_id=company.id,
        check_number=req.check_number.strip(), check_date=req.check_date,
        amount_cents=req.amount_cents, micr=req.micr.strip(),
        created_by=user_id, created_at=utc_now(),
    )
    if req.decision == "decline":
        row.status = "declined"
        row.reason = req.reason.strip()
        db.add(row)
        db.flush()
        return row

    blocks = result.codes("block")
    if blocks:
        raise CheckCashingConflictError(
            "This check cannot be cashed: " + ", ".join(sorted(blocks)) + ".",
        )
    needs_ack = result.codes("warn", "approve")
    missing = needs_ack - req.acknowledged
    if missing:
        raise CheckCashingConflictError(
            "Tick the warnings first: " + ", ".join(sorted(missing)) + ".",
        )
    approvals = result.codes("approve")
    if approvals and not can_approve:
        raise PermissionError(
            "A manager must approve: " + ", ".join(sorted(approvals)) + ".",
        )
    assert result.fee is not None
    if req.fee_cents > req.amount_cents:
        raise CheckCashingConflictError("The fee cannot be more than the check.")
    row.status = "cashed"
    row.fee_kind = result.fee.kind
    row.fee_value = result.fee.value
    row.fee_suggested_cents = result.fee.cents
    row.fee_cents = req.fee_cents
    row.cash_cents = req.amount_cents - req.fee_cents
    row.warnings = ",".join(sorted(needs_ack))[:255]
    row.approved_by = user_id if approvals else None
    db.add(row)
    db.flush()
    return row


def get_check(db: Session, store_ids: list[int], check_id: int) -> CashedCheck:
    row = db.get(CashedCheck, check_id)
    if row is None or row.store_id not in store_ids:
        raise CheckCashingNotFoundError("Check not found")
    return row


def void(
    db: Session, store_id: int, check_id: int, *, user_id: int, reason: str,
    today: date,
) -> CashedCheck:
    """Undo a cashed check, at the store that cashed it, on the same
    store day (later it is a bad check: ``bad_checks.report``)."""
    row = get_check(db, [store_id], check_id)
    if row.status != "cashed":
        raise CheckCashingConflictError("Only a cashed check can be voided.")
    if row.store_day != today:
        raise CheckCashingConflictError(
            "A check can be voided only on the day it was cashed.",
        )
    if bad_checks_for(db, [int(row.id)]):
        raise CheckCashingConflictError("A bad check cannot be voided.")
    row.status = "voided"
    row.voided_by = user_id
    row.voided_at = utc_now()
    row.void_reason = reason.strip()
    db.flush()
    return row


@dataclass
class Stats:
    count: int
    total_cents: int
    max_cents: int
    last_day: date | None
    last_cents: int | None
    declined: int
    voided: int


def stats(db: Session, store_ids: list[int], **match: int) -> Stats:
    """Totals for a customer or a company (``customer_id=`` or
    ``company_id=``) over ``store_ids``."""
    base = checks_query(db, store_ids).filter_by(**match)
    cashed = base.filter(CashedCheck.status == "cashed")
    count, total, biggest = cashed.with_entities(
        func.count(CashedCheck.id),
        func.coalesce(func.sum(CashedCheck.amount_cents), 0),
        func.coalesce(func.max(CashedCheck.amount_cents), 0),
    ).one()
    last = cashed.order_by(CashedCheck.created_at.desc(), CashedCheck.id.desc()).first()
    declined = base.filter(CashedCheck.status == "declined").count()
    voided = base.filter(CashedCheck.status == "voided").count()
    return Stats(
        count=int(count), total_cents=int(total), max_cents=int(biggest),
        last_day=last.store_day if last else None,
        last_cents=int(last.amount_cents) if last else None,
        declined=declined, voided=voided,
    )


def company_customers(
    db: Session, store_ids: list[int], company_id: int, limit: int = 50,
) -> list[tuple[CheckCustomer, int, date]]:
    """Customers who cashed this company's checks: most checks first."""
    rows = (
        checks_query(db, store_ids)
        .filter(CashedCheck.company_id == company_id, CashedCheck.status == "cashed")
        .with_entities(
            CashedCheck.customer_id,
            func.count(CashedCheck.id),
            func.max(CashedCheck.store_day),
        )
        .group_by(CashedCheck.customer_id)
        .order_by(func.count(CashedCheck.id).desc(), func.max(CashedCheck.store_day).desc())
        .limit(limit)
        .all()
    )
    out: list[tuple[CheckCustomer, int, date]] = []
    for customer_id, count, last_day in rows:
        customer = db.get(CheckCustomer, customer_id)
        if customer is not None:
            out.append((customer, int(count), last_day))
    return out


def find_company_by_numbers(
    db: Session, store_ids: list[int], routing: str, account: str,
) -> CheckCompany | None:
    if not routing or not account:
        return None
    return (
        db.query(CheckCompany)
        .filter(
            CheckCompany.store_id.in_(store_ids),
            CheckCompany.routing_number == routing,
            CheckCompany.account_number == account,
        )
        .first()
    )


def rehome_shared_parties(db: Session, store_id: int) -> None:
    """Before a store's data is purged: a customer or company it added
    that another store has cashed checks for moves to the store with
    the latest such check, IDs and all, so that store's records keep
    their customer and company. Called by the retention purge."""
    from api.Modules.CheckCashing.Models import CheckCustomerId

    def latest_other_store(column: Any, party_id: int) -> int | None:
        row = (
            db.query(CashedCheck.store_id)
            .filter(column == party_id, CashedCheck.store_id != store_id)
            .order_by(CashedCheck.created_at.desc(), CashedCheck.id.desc())
            .first()
        )
        return int(row[0]) if row else None

    for customer in db.query(CheckCustomer).filter_by(store_id=store_id).all():
        new_home = latest_other_store(CashedCheck.customer_id, int(customer.id))
        if new_home is not None:
            customer.store_id = new_home
            db.query(CheckCustomerId).filter_by(customer_id=customer.id).update(
                {"store_id": new_home}, synchronize_session=False,
            )
    for company in db.query(CheckCompany).filter_by(store_id=store_id).all():
        new_home = latest_other_store(CashedCheck.company_id, int(company.id))
        if new_home is not None:
            company.store_id = new_home
    # A person of the doomed store (an owner working at a sibling
    # store) who cashed, approved or voided a check there: the check
    # stays, the pointer at the deleted login goes.
    from api.Modules.Tenancy.Models import User
    user_ids = [int(u) for (u,) in db.query(User.id).filter_by(store_id=store_id)]
    if user_ids:
        others = db.query(CashedCheck).filter(CashedCheck.store_id != store_id)
        for col in ("created_by", "approved_by", "voided_by"):
            others.filter(getattr(CashedCheck, col).in_(user_ids)).update(
                {col: None}, synchronize_session=False,
            )
    db.flush()
