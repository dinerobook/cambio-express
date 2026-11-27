"""Bank-charges aggregation Service.

Pure-DB readers used by the monthly P&L:

  - `bank_charges_for_month`: scalar sum of absolute amounts for
    a single category (or a prefix family). Feeds the
    `MonthlyFinancial.bank_charges_total` auto-fill and per-account
    P&L lines (bank_charges_210 / 230 / etc).
  - `bank_charges_breakdown_for_month`: two-level group-by
    description for the expandable Bank Charges block on the P&L.
    Sorted by total descending.

Both functions accept a SQLAlchemy `Session` so callers can run
them outside the Flask app context (CLI exports, tests, future
FastAPI controllers).
"""
from calendar import monthrange
from datetime import datetime
from typing import Any

from sqlalchemy import or_, func
from sqlalchemy.orm import Session

from api.Modules.BankSync.Models import BankTransaction, StripeBankAccount


def booking_day_expr() -> Any:
    """SQL for the day a bank row books on: the stored override (a
    person's pick, or a rule's offset) else the bank's posting date.
    The same order as `categorize.booking_date_for` for a row that is
    not linked to a daily book entry."""
    return func.coalesce(
        BankTransaction.report_date_override,
        func.date(BankTransaction.posted_at),
    )


def month_clauses(
    year: int, month: int, *, by_booking_day: bool = False,
) -> list[Any]:
    """Which of a store's bank rows belong to one month.

    Off (every store today): the bank's posting date, as always.
    On (`pl_transactions`, Monthly INVARIANTS "Month-end"): the
    booking day, so a deposit the daily book has on Nov 30 that the
    bank posts Dec 1 counts in November; dismissed and void rows
    count nowhere."""
    if by_booking_day:
        from api.Modules.Monthly.Services.daily_feed import month_bounds
        start, end = month_bounds(year, month)
        day = booking_day_expr()
        return [
            day >= start, day <= end,
            BankTransaction.dismissed_at.is_(None),
            or_(BankTransaction.status.is_(None),
                BankTransaction.status != "void"),
        ]
    month_start = datetime(year, month, 1)
    month_end_d = monthrange(year, month)[1]
    month_end = datetime(year, month, month_end_d, 23, 59, 59)
    return [
        BankTransaction.posted_at >= month_start,
        BankTransaction.posted_at <= month_end,
    ]


def bank_charges_for_month(
    db: Session,
    store_id: int,
    year: int,
    month: int,
    category_slug: str | None = None,
    *,
    prefix: str | None = None,
    by_booking_day: bool = False,
) -> float:
    """Sum the absolute amount of `BankTransaction` rows tagged for
    the given month.

    Pass either an exact `category_slug` or a `prefix` (used by
    the bank-charges P&L feed to roll up every per-account slug
    like `bank_charge / bank_charge_210 / bank_charge_<last4>` in
    one query).

    Stored amounts are signed (debits negative); P&L expense
    columns use positive numbers, so we abs(). Returns 0.0 when
    no transactions match — the monthly_report route only LOCKs
    the P&L field when this is > 0, leaving the manual value in
    place for stores without bank sync.
    """
    q = db.query(
        func.coalesce(func.sum(BankTransaction.amount_cents), 0)
    ).filter(
        BankTransaction.store_id == store_id,
        *month_clauses(year, month, by_booking_day=by_booking_day),
    )
    if prefix is not None:
        # SQL prefix match. Trailing % does the heavy lifting; we
        # also accept the bare prefix itself (no underscore suffix)
        # so the legacy `bank_charge` slug counts.
        q = q.filter(or_(
            BankTransaction.category_slug == prefix,
            BankTransaction.category_slug.like(f"{prefix}_%"),
        ))
    else:
        q = q.filter(BankTransaction.category_slug == category_slug)
    cents = q.scalar()
    return abs(float(cents or 0)) / 100.0


def bank_charges_breakdown_for_month(
    db: Session, store_id: int, year: int, month: int,
    *, by_booking_day: bool = False,
) -> list[dict[str, Any]]:
    """Two-level breakdown feeding the expandable Bank Charges
    block on the monthly P&L.

    Groups bank-charge transactions by description string; each
    group exposes its individual rows.

    Returns a list of dicts:
      [
        {"description": "REMOTE DEPOSIT FEE",
         "total":       2.10,
         "count":       1,
         "transactions": [
           {"posted_at":     datetime,
            "amount":        2.10,
            "account_label": "••0230" or nickname,
            "description":   "REMOTE DEPOSIT FEE 04/29"},
         ]},
        ...
      ]

    Sorted by total descending so the biggest contributor reads
    first. Uses a prefix match on `bank_charge%` so every
    per-account slug (`bank_charge_210`, `bank_charge_230`, future
    `bank_charge_<last4>`) rolls into the breakdown without
    explicit registry maintenance.
    """
    rows = (
        db.query(BankTransaction)
          .filter(
              BankTransaction.store_id == store_id,
              or_(
                  BankTransaction.category_slug == "bank_charge",
                  BankTransaction.category_slug.like("bank_charge_%"),
              ),
              *month_clauses(year, month, by_booking_day=by_booking_day),
          )
          .order_by(BankTransaction.posted_at.desc())
          .all()
    )
    if not rows:
        return []
    # Map account ids → row to avoid N+1 lookup per transaction.
    acct_ids = {
        r.stripe_bank_account_id for r in rows
        if r.stripe_bank_account_id
    }
    if acct_ids:
        accts = {
            a.id: a for a in db.query(StripeBankAccount)
                                 .filter(StripeBankAccount.id.in_(acct_ids))
                                 .all()
        }
    else:
        accts = {}
    # Group by description. The exact full description is the key
    # — operators want each variant visible (e.g. "REMOTE DEPOSIT
    # FEE 04/29" and "REMOTE DEPOSIT FEE 05/02" group separately
    # if the bank includes the date in the string).
    groups: dict[str, dict[str, Any]] = {}
    for r in rows:
        key = str(r.description or "(no description)")
        g = groups.setdefault(key, {
            "description": key,
            "total": 0.0,
            "count": 0,
            "transactions": [],
        })
        amt = abs(float(r.amount_cents or 0) / 100.0)
        g["total"] += amt
        g["count"] += 1
        acct = accts.get(r.stripe_bank_account_id)
        g["transactions"].append({
            "posted_at": r.posted_at,
            "amount": amt,
            "description": r.description or "",
            "account_label": acct.label if acct else "",
        })
    return sorted(
        groups.values(), key=lambda g: g["total"], reverse=True,
    )


def bank_pl_sums_for_month(
    db: Session, store_id: int, year: int, month: int,
    *, by_booking_day: bool = False,
) -> dict[str, float]:
    """Every MonthlyFinancial column the bank feed can fill, with
    the month's summed absolute amount — `bank_charges_total` from
    the bank-charge slug family plus one entry per `pl_*` category
    that has at least one tagged row.

    Columns with no tagged rows are ABSENT from the result rather
    than 0.0: the monthly P&L treats presence as "the bank is
    speaking for this line this month" (server value wins) and
    absence as "the operator types it". Returning zeros would
    silently lock every line on every store with a connected bank.
    """
    from api.Modules.BankSync.Services.categories import (
        BANK_CHARGES_PL_FIELD, BANK_PL_CATEGORIES,
    )

    out: dict[str, float] = {}
    charges = bank_charges_for_month(
        db, store_id, year, month, prefix="bank_charge",
        by_booking_day=by_booking_day,
    )
    if charges > 0:
        out[BANK_CHARGES_PL_FIELD] = charges

    rows = (
        db.query(
            BankTransaction.category_slug,
            func.coalesce(func.sum(func.abs(BankTransaction.amount_cents)), 0),
        )
        .filter(
            BankTransaction.store_id == store_id,
            *month_clauses(year, month, by_booking_day=by_booking_day),
            BankTransaction.category_slug.in_(list(BANK_PL_CATEGORIES)),
        )
        .group_by(BankTransaction.category_slug)
        .all()
    )
    for slug, cents in rows:
        field = BANK_PL_CATEGORIES[str(slug)]
        dollars = float(cents or 0) / 100.0
        if dollars > 0:
            out[field] = round(out.get(field, 0.0) + dollars, 2)
    return out
