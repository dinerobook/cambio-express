"""Check cashing — Bad checks.

A cashed check the bank sent back (no funds, closed account, stopped
payment, fraud) becomes a bad check: the customer owes the check's
amount plus the store's returned-check fee until they pay it back, or a
manager writes the rest off. While one is open the review asks a
manager to approve the next check from that customer or company.

This file is the only writer of ``BadCheck`` / ``BadCheckPayment``.
Money is integer cents. Rules: this module's ``INVARIANTS.md`` ("Bad
checks").
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy import func, or_
from sqlalchemy.orm import Query, Session

from api.Core.Clock import utc_now
from api.Modules.CheckCashing.Models import (
    BadCheck, BadCheckPayment, CashedCheck, CheckCompany, CheckCustomer,
)
from api.Modules.CheckCashing.Services import (
    CheckCashingConflictError, CheckCashingNotFoundError,
)


def bad_checks_query(db: Session, store_ids: list[int]) -> Query[BadCheck]:
    return db.query(BadCheck).filter(BadCheck.store_id.in_(store_ids))


def balance(row: BadCheck) -> int:
    return int(row.owed_cents or 0) - int(row.paid_cents or 0)


def get_bad_check(db: Session, store_ids: list[int], bad_check_id: int) -> BadCheck:
    row = db.get(BadCheck, bad_check_id)
    if row is None or row.store_id not in store_ids:
        raise CheckCashingNotFoundError("Bad check not found")
    return row


def bad_checks_for(db: Session, check_ids: list[int]) -> dict[int, BadCheck]:
    """The bad check of each of these cashed checks, if any."""
    if not check_ids:
        return {}
    return {
        int(b.cashed_check_id): b
        for b in db.query(BadCheck).filter(BadCheck.cashed_check_id.in_(check_ids))
    }


def report(
    db: Session, store_id: int, check_id: int, *, user_id: int, reason: str,
    returned_on: date, fee_cents: int, note: str, today: date,
) -> BadCheck:
    """Mark a cashed check as sent back, at the store that cashed it."""
    check = db.get(CashedCheck, check_id)
    if check is None or check.store_id != store_id:
        raise CheckCashingNotFoundError("Check not found")
    if check.status != "cashed":
        raise CheckCashingConflictError("Only a cashed check can be a bad check.")
    if db.query(BadCheck.id).filter_by(cashed_check_id=check.id).first():
        raise CheckCashingConflictError("This check is already a bad check.")
    if returned_on > today or returned_on < check.store_day:
        raise CheckCashingConflictError(
            "The return date must be between the day the check was cashed and today.",
        )
    row = BadCheck(
        store_id=store_id, cashed_check_id=check.id, reason=reason,
        returned_on=returned_on, fee_cents=fee_cents,
        owed_cents=int(check.amount_cents) + fee_cents, paid_cents=0,
        status="open", note=note.strip(), created_by=user_id,
        created_at=utc_now(),
    )
    db.add(row)
    db.flush()
    return row


def add_payment(
    db: Session, store_id: int, store_ids: list[int], bad_check_id: int, *,
    user_id: int, amount_cents: int, note: str, today: date,
) -> tuple[BadCheck, BadCheckPayment]:
    """Money the customer brought back, at any store of the owner.
    Never more than what is left; the bad check is paid at zero."""
    row = get_bad_check(db, store_ids, bad_check_id)
    if row.status != "open":
        raise CheckCashingConflictError("This bad check is closed.")
    left = balance(row)
    if amount_cents > left:
        raise CheckCashingConflictError(
            f"The payment is more than what is owed (${left / 100:,.2f}).",
        )
    payment = BadCheckPayment(
        bad_check_id=row.id, store_id=store_id, paid_on=today,
        amount_cents=amount_cents, note=note.strip(), created_by=user_id,
        created_at=utc_now(),
    )
    db.add(payment)
    row.paid_cents = int(row.paid_cents or 0) + amount_cents
    if balance(row) == 0:
        row.status = "paid"
        row.closed_at = utc_now()
    db.flush()
    return row, payment


def write_off(
    db: Session, store_ids: list[int], bad_check_id: int, *, user_id: int,
    note: str,
) -> BadCheck:
    """A manager gives up on what is left: it is a loss."""
    row = get_bad_check(db, store_ids, bad_check_id)
    if row.status != "open":
        raise CheckCashingConflictError("This bad check is closed.")
    row.status = "written_off"
    row.written_off_by = user_id
    row.write_off_note = note.strip()
    row.closed_at = utc_now()
    db.flush()
    return row


@dataclass
class OpenBadChecks:
    count: int
    owed_cents: int


def open_bad_checks(
    db: Session, store_ids: list[int], **match: int,
) -> OpenBadChecks:
    """Open bad checks of a customer or a company (``customer_id=`` or
    ``company_id=``) across ``store_ids``, or of everyone."""
    query = (
        bad_checks_query(db, store_ids)
        .join(CashedCheck, CashedCheck.id == BadCheck.cashed_check_id)
        .filter(BadCheck.status == "open")
    )
    for key, value in match.items():
        query = query.filter(getattr(CashedCheck, key) == value)
    count, owed = query.with_entities(
        func.count(BadCheck.id),
        func.coalesce(func.sum(BadCheck.owed_cents - BadCheck.paid_cents), 0),
    ).one()
    return OpenBadChecks(count=int(count), owed_cents=int(owed))


def list_query(
    db: Session, store_ids: list[int], *, status: str, q: str,
) -> Query[BadCheck]:
    query = (
        bad_checks_query(db, store_ids)
        .join(CashedCheck, CashedCheck.id == BadCheck.cashed_check_id)
        .join(CheckCustomer, CheckCustomer.id == CashedCheck.customer_id)
        .join(CheckCompany, CheckCompany.id == CashedCheck.company_id)
    )
    if status:
        query = query.filter(BadCheck.status == status)
    text = q.strip()
    if len(text) >= 2:
        like = f"%{text.lower()}%"
        query = query.filter(or_(
            func.lower(CheckCustomer.full_name).like(like),
            func.lower(CheckCompany.name).like(like),
            CashedCheck.check_number.like(f"%{text}%"),
        ))
    return query.order_by(BadCheck.returned_on.desc(), BadCheck.id.desc())


def rehome_bad_checks(db: Session, store_id: int) -> None:
    """Before a store's data is purged: every payback touching it
    follows its bad check (one the store took for a sibling's bad check
    moves to that store; one a sibling took for the store's own bad
    check goes with it), and pointers at the store's logins on a
    sibling's bad checks are cleared. Called by the retention purge."""
    own = [int(i) for (i,) in db.query(BadCheck.id).filter_by(store_id=store_id)]
    touching = db.query(BadCheckPayment).filter(or_(
        BadCheckPayment.store_id == store_id,
        BadCheckPayment.bad_check_id.in_(own),
    ))
    for payment in touching.all():
        payment.store_id = payment.bad_check.store_id
    db.flush()
    from api.Modules.Tenancy.Models import User
    user_ids = [int(u) for (u,) in db.query(User.id).filter_by(store_id=store_id)]
    if user_ids:
        others = db.query(BadCheck).filter(BadCheck.store_id != store_id)
        for col in ("created_by", "written_off_by"):
            others.filter(getattr(BadCheck, col).in_(user_ids)).update(
                {col: None}, synchronize_session="fetch",
            )
        db.query(BadCheckPayment).filter(
            BadCheckPayment.store_id != store_id,
            BadCheckPayment.created_by.in_(user_ids),
        ).update({"created_by": None}, synchronize_session="fetch")
    db.flush()
