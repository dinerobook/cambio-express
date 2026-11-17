"""Check cashing — Currency Transaction Reports (FinCEN CTR).

A business that pays one person more than $10,000 in cash in one
business day files a CTR within 15 days. Under FinCEN's Southwest
Border order (a store setting) cash from $1,000 is reported too, within
30 days. The cash is the customer's ``cash_cents`` on every cashed
check that store day, across the owner's stores that share an EIN (one
business for FinCEN).

This module is the only writer of ``msb_check_ctr``:

* ``sync()`` runs after every cashing and void: it opens the day's
  report when the cash goes over the line, keeps its totals in step,
  and marks it not needed when a void takes the day back under.
* ``mark_filed()`` saves FinCEN's 14-digit BSA ID; a filed report is
  locked.

At the counter ``details_missing()`` names what the customer's profile
still lacks; the cashier fills it in before the money leaves the
drawer. Rules: this module's ``INVARIANTS.md`` ("CTR").
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Query, Session

from api.Core.Clock import utc_now
from api.Modules.CheckCashing.Models import (
    CashedCheck, CheckCashingSettings, CheckCustomer, CtrReport,
)
from api.Modules.CheckCashing.Services import (
    CheckCashingConflictError, CheckCashingNotFoundError, umbrella,
)

# Over this much cash in a business day: a CTR (31 CFR 1010.311).
CTR_OVER_CENTS = 1_000_000
# From this much under the Southwest Border order (GTO).
GTO_FROM_CENTS = 100_000
CTR_DAYS = 15
GTO_DAYS = 30
# The order's mark in the CTR's field 45.
GTO_MARK = "MSB0926GTO"

# What the counter asks for before paying out, in the order the form
# shows it. ``tin`` = SSN, ITIN or a foreign number.
DETAIL_FIELDS = ("dob", "tin", "occupation", "address", "city", "state", "zip_code")


def store_ein(db: Session, store_id: int) -> str:
    row = db.query(CheckCashingSettings.ein).filter_by(store_id=store_id).first()
    return (row[0] or "") if row else ""


def gto_enabled(db: Session, store_id: int) -> bool:
    row = db.query(CheckCashingSettings.gto_enabled).filter_by(store_id=store_id).first()
    return bool(row and row[0])


def group(db: Session, store_id: int) -> list[int]:
    """The stores whose cash is added up with this store's: the owner
    umbrella's stores with the same EIN (a blank EIN matches blank)."""
    stores = umbrella(db, store_id)
    eins = dict(
        db.query(CheckCashingSettings.store_id, CheckCashingSettings.ein)
        .filter(CheckCashingSettings.store_id.in_(stores))
        .all(),
    )
    mine = eins.get(store_id) or ""
    return [s for s in stores if (eins.get(s) or "") == mine]


def threshold_kind(cash_cents: int, gto: bool) -> str | None:
    """``ctr``, ``gto`` or None when nothing is reported."""
    if cash_cents > CTR_OVER_CENTS:
        return "ctr"
    if gto and cash_cents >= GTO_FROM_CENTS:
        return "gto"
    return None


def day_cash(
    db: Session, store_ids: list[int], customer_id: int, day: date,
) -> tuple[int, int]:
    """The customer's cash paid out and cashed-check count that day."""
    count, total = (
        db.query(func.count(CashedCheck.id), func.coalesce(func.sum(CashedCheck.cash_cents), 0))
        .filter(
            CashedCheck.store_id.in_(store_ids),
            CashedCheck.customer_id == customer_id,
            CashedCheck.store_day == day,
            CashedCheck.status == "cashed",
        )
        .one()
    )
    return int(total), int(count)


def details_missing(customer: CheckCustomer) -> list[str]:
    """What the CTR needs that the profile does not have yet."""
    have = {
        "dob": customer.dob is not None,
        "tin": bool(customer.tin_encrypted),
        "occupation": bool((customer.occupation or "").strip()),
        "address": bool((customer.address or "").strip()),
        "city": bool((customer.city or "").strip()),
        "state": bool((customer.state or "").strip()),
        "zip_code": bool((customer.zip_code or "").strip()),
    }
    return [f for f in DETAIL_FIELDS if not have[f]]


def sync(db: Session, store_id: int, customer_id: int, day: date) -> CtrReport | None:
    """Bring the customer's report for ``day`` in step with their
    cashed checks. Opens it over the line, updates it, or marks it not
    needed; a filed report is never changed."""
    ein = store_ein(db, store_id)
    cash, count = day_cash(db, group(db, store_id), customer_id, day)
    kind = threshold_kind(cash, gto_enabled(db, store_id))
    row = (
        db.query(CtrReport)
        .filter_by(customer_id=customer_id, store_day=day, ein=ein)
        .first()
    )
    if row is not None and row.status == "filed":
        return row
    if kind is None:
        if row is not None and row.status == "to_file":
            row.status = "not_needed"
            row.cash_cents, row.check_count = cash, count
            row.updated_at = utc_now()
            db.flush()
        return row
    if row is None:
        row = CtrReport(
            store_id=store_id, customer_id=customer_id, store_day=day, ein=ein,
            created_at=utc_now(),
        )
        db.add(row)
    row.kind = kind
    row.cash_cents, row.check_count = cash, count
    row.status = "to_file"
    row.due_on = day + timedelta(days=CTR_DAYS if kind == "ctr" else GTO_DAYS)
    row.updated_at = utc_now()
    db.flush()
    return row


CTR_SORT = (CtrReport.due_on, CtrReport.id)


def list_query(
    db: Session, store_ids: list[int], *, status: str = "", q: str = "",
) -> Query[CtrReport]:
    """The umbrella's reports, soonest due first. ``status`` empty =
    all but not needed; ``q`` matches the customer's name."""
    query = db.query(CtrReport).filter(CtrReport.store_id.in_(store_ids))
    if status:
        query = query.filter(CtrReport.status == status)
    else:
        query = query.filter(CtrReport.status != "not_needed")
    needle = q.strip()
    if len(needle) >= 2:
        query = query.join(CheckCustomer, CheckCustomer.id == CtrReport.customer_id).filter(
            func.lower(CheckCustomer.full_name).like(f"%{needle.lower()}%"),
        )
    return query.order_by(*CTR_SORT)


@dataclass
class CtrCounts:
    to_file: int
    overdue: int
    due_soon: int


# Due within this many days: the warning tone and the bell.
DUE_SOON_DAYS = 5


def counts(db: Session, store_ids: list[int], today: date) -> CtrCounts:
    open_q = db.query(CtrReport).filter(
        CtrReport.store_id.in_(store_ids), CtrReport.status == "to_file",
    )
    return CtrCounts(
        to_file=open_q.count(),
        overdue=open_q.filter(CtrReport.due_on < today).count(),
        due_soon=open_q.filter(
            CtrReport.due_on >= today,
            CtrReport.due_on <= today + timedelta(days=DUE_SOON_DAYS),
        ).count(),
    )


def get(db: Session, store_ids: list[int], ctr_id: int) -> CtrReport:
    row = db.get(CtrReport, ctr_id)
    if row is None or row.store_id not in store_ids:
        raise CheckCashingNotFoundError("Report not found")
    return row


def report_checks(db: Session, row: CtrReport) -> list[CashedCheck]:
    """The cashed checks the report covers, oldest first."""
    return (
        db.query(CashedCheck)
        .filter(
            CashedCheck.store_id.in_(group(db, int(row.store_id))),
            CashedCheck.customer_id == row.customer_id,
            CashedCheck.store_day == row.store_day,
            CashedCheck.status == "cashed",
        )
        .order_by(CashedCheck.created_at, CashedCheck.id)
        .all()
    )


def mark_filed(
    db: Session, store_ids: list[int], ctr_id: int, *, bsa_id: str,
    filed_on: date, user_id: int, today: date,
) -> CtrReport:
    row = get(db, store_ids, ctr_id)
    if row.status != "to_file":
        raise CheckCashingConflictError("Only a report still to file can be marked filed.")
    if not (len(bsa_id) == 14 and bsa_id.isdigit()):
        raise CheckCashingConflictError("The BSA ID is the 14 digits FinCEN gives back.")
    if filed_on < row.store_day or filed_on > today:
        raise CheckCashingConflictError(
            "The filing date must be between the business day and today.",
        )
    row.status = "filed"
    row.bsa_id = bsa_id
    row.filed_on = filed_on
    row.filed_by = user_id
    row.updated_at = utc_now()
    db.flush()
    return row


def clear_logins(db: Session, store_id: int, user_ids: list[int]) -> None:
    """Before a store is purged: a sibling's report filed by one of its
    logins keeps the report and loses the pointer."""
    if user_ids:
        db.query(CtrReport).filter(
            CtrReport.store_id != store_id, CtrReport.filed_by.in_(user_ids),
        ).update({"filed_by": None}, synchronize_session=False)
