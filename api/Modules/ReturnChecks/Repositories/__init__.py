"""ReturnChecks — Repositories."""
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Query, Session

from api.Core.Sorting import order_by_slug
from api.Modules.ReturnChecks.Models import (
    ReturnCheck, ReturnCheckBatch, ReturnCheckPayment,
)
from api.Modules.ReturnChecks.parties import party_key

# Column slugs the list sorts by (``?sort=``); anything else = newest
# bounce first.
SORT_COLUMNS: dict[str, Any] = {
    "bounced":  ReturnCheck.bounced_on,
    "customer": ReturnCheck.customer_name,
    "check":    ReturnCheck.check_number,
    "bank":     ReturnCheck.payer_bank,
    "amount":   ReturnCheck.amount_cents,
    "status":   ReturnCheck.status,
    "company":  ReturnCheck.company_name,
}

# Batch list sort slugs; anything else = newest return first.
BATCH_SORT_COLUMNS: dict[str, Any] = {
    "returned":  ReturnCheckBatch.returned_on,
    "reference": ReturnCheckBatch.reference,
}


def list_return_checks(
    db: Session, store_id: int,
    *, status: str = "",
) -> list[ReturnCheck]:
    """Bounced checks for one store, newest-first by bounced_on.
    Optional status filter — empty returns all."""
    return return_checks_query(db, store_id, status=status).all()


def _like(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def party_check_ids(
    db: Session, store_id: int, *, company: str = "", customer: str = "",
) -> list[int]:
    """Ids of the store's checks whose company / customer name has the
    given grouping key (``party_key``) — the same rule the By company
    and By customer lists group with, so a row there opens exactly
    its checks."""
    rows = (
        db.query(ReturnCheck.id, ReturnCheck.company_name, ReturnCheck.customer_name)
          .filter_by(store_id=store_id)
          .all()
    )
    return [
        int(rid) for rid, comp, cust in rows
        if (not company or party_key(comp) == company)
        and (not customer or party_key(cust) == customer)
    ]


def return_checks_query(
    db: Session, store_id: int,
    *, status: str = "", sort: str = "", direction: str = "desc",
    q: str = "", batch_id: int | None = None,
    company: str = "", customer: str = "",
) -> Query:
    """The store's bounced checks as a sorted query, for paging.

    ``q`` searches customer, company, check number, bank and routing
    number; ``company`` / ``customer`` are grouping keys from the
    tracking lists; ``batch_id`` keeps one batch's checks."""
    query = db.query(ReturnCheck).filter_by(store_id=store_id)
    if status:
        query = query.filter_by(status=status)
    if batch_id is not None:
        query = query.filter_by(batch_id=batch_id)
    text = (q or "").strip()
    if text:
        pattern = _like(text)
        query = query.filter(or_(
            ReturnCheck.customer_name.ilike(pattern, escape="\\"),
            ReturnCheck.company_name.ilike(pattern, escape="\\"),
            ReturnCheck.check_number.ilike(pattern, escape="\\"),
            ReturnCheck.payer_bank.ilike(pattern, escape="\\"),
            ReturnCheck.routing_number.ilike(pattern, escape="\\"),
        ))
    if company or customer:
        ids = party_check_ids(db, store_id, company=company, customer=customer)
        query = query.filter(ReturnCheck.id.in_(ids or [-1]))
    return order_by_slug(
        query, SORT_COLUMNS, sort, direction,
        default=(ReturnCheck.bounced_on.desc(), ReturnCheck.id.desc()),
        tiebreak=(ReturnCheck.id.desc(),),
    )


def batches_query(
    db: Session, store_id: int,
    *, q: str = "", sort: str = "", direction: str = "desc",
) -> Query:
    """The store's returned batches, newest return first. ``q``
    matches the bank reference, the notes, or any check in the batch
    by customer, company or check number."""
    query = db.query(ReturnCheckBatch).filter_by(store_id=store_id)
    text = (q or "").strip()
    if text:
        pattern = _like(text)
        in_checks = (
            db.query(ReturnCheck.batch_id)
              .filter(ReturnCheck.store_id == store_id)
              .filter(ReturnCheck.batch_id.isnot(None))
              .filter(or_(
                  ReturnCheck.customer_name.ilike(pattern, escape="\\"),
                  ReturnCheck.company_name.ilike(pattern, escape="\\"),
                  ReturnCheck.check_number.ilike(pattern, escape="\\"),
              ))
        )
        query = query.filter(or_(
            ReturnCheckBatch.reference.ilike(pattern, escape="\\"),
            ReturnCheckBatch.notes.ilike(pattern, escape="\\"),
            ReturnCheckBatch.id.in_(in_checks),
        ))
    return order_by_slug(
        query, BATCH_SORT_COLUMNS, sort, direction,
        default=(ReturnCheckBatch.returned_on.desc(), ReturnCheckBatch.id.desc()),
        tiebreak=(ReturnCheckBatch.id.desc(),),
    )


def find_batch(
    db: Session, store_id: int, batch_id: int,
) -> ReturnCheckBatch | None:
    return (
        db.query(ReturnCheckBatch)
          .filter_by(id=batch_id, store_id=store_id)
          .first()
    )


def find_return_check(
    db: Session, store_id: int, rc_id: int,
) -> ReturnCheck | None:
    return (
        db.query(ReturnCheck)
          .filter_by(id=rc_id, store_id=store_id)
          .first()
    )


def list_payments(
    db: Session, store_id: int, rc_id: int,
) -> list[ReturnCheckPayment]:
    """Payments for one ReturnCheck, ordered by paid_on asc.

    `ReturnCheckPayment` doesn't carry `store_id` directly —
    tenancy is enforced via the parent ReturnCheck's store_id
    (callers must verify `find_return_check` returns non-None
    first). We re-scope here defensively by checking the parent
    again before returning rows."""
    rc = find_return_check(db, store_id, rc_id)
    if rc is None:
        return []
    return (
        db.query(ReturnCheckPayment)
          .filter_by(return_check_id=rc_id)
          .order_by(
              ReturnCheckPayment.paid_on.asc(),
              ReturnCheckPayment.id.asc(),
          )
          .all()
    )


def find_payment(
    db: Session, store_id: int, rc_id: int, payment_id: int,
) -> ReturnCheckPayment | None:
    """Single payment scoped to (store, return_check, payment).

    Tenancy is enforced via the parent ReturnCheck — we look up the
    rc first to confirm it belongs to ``store_id``, then return the
    payment only if its FK matches.
    """
    rc = find_return_check(db, store_id, rc_id)
    if rc is None:
        return None
    return (
        db.query(ReturnCheckPayment)
          .filter_by(id=payment_id, return_check_id=rc_id)
          .first()
    )


__all__ = [
    "batches_query", "find_batch", "party_check_ids",
    "find_payment", "find_return_check", "list_payments", "list_return_checks",
    "return_checks_query",
]
