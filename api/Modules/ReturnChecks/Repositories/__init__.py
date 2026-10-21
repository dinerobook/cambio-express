"""ReturnChecks — Repositories."""
from typing import Any

from sqlalchemy.orm import Query, Session

from api.Core.Sorting import order_by_slug
from api.Modules.ReturnChecks.Models import ReturnCheck, ReturnCheckPayment

# Column slugs the list sorts by (``?sort=``); anything else = newest
# bounce first.
SORT_COLUMNS: dict[str, Any] = {
    "bounced":  ReturnCheck.bounced_on,
    "customer": ReturnCheck.customer_name,
    "check":    ReturnCheck.check_number,
    "bank":     ReturnCheck.payer_bank,
    "amount":   ReturnCheck.amount_cents,
    "status":   ReturnCheck.status,
}


def list_return_checks(
    db: Session, store_id: int,
    *, status: str = "",
) -> list[ReturnCheck]:
    """Bounced checks for one store, newest-first by bounced_on.
    Optional status filter — empty returns all."""
    return return_checks_query(db, store_id, status=status).all()


def return_checks_query(
    db: Session, store_id: int,
    *, status: str = "", sort: str = "", direction: str = "desc",
) -> Query:
    """The store's bounced checks as a sorted query, for paging."""
    q = db.query(ReturnCheck).filter_by(store_id=store_id)
    if status:
        q = q.filter_by(status=status)
    return order_by_slug(
        q, SORT_COLUMNS, sort, direction,
        default=(ReturnCheck.bounced_on.desc(), ReturnCheck.id.desc()),
        tiebreak=(ReturnCheck.id.desc(),),
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
    "find_payment", "find_return_check", "list_payments", "list_return_checks",
    "return_checks_query",
]
