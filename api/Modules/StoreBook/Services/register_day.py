"""StoreBook — the register's day close on the daily book.

The register closes a business day by writing day reports (PosImport's
movement tables: TLM tax levels, MCM departments, FGM fuel, MSM
payment types and payouts). ``register_day`` reads them and says what
each line of the daily book should hold, or why the day cannot be
filled yet. It writes nothing. ``pull_register_day`` is the one
writer, through ``apply_import``, so the register's figure is kept as
each line's original and a number a person typed is never replaced.

Opt-in per store (``REGISTER_DAY_FLAG``, off by default): nothing
changes for a store until it is switched on.

The rules, checked to the cent on three real days (5-7 Dec 2025):

* **Taxable and non taxable come from TLM**, never from MCM
  ``SalesAmount``: MCM does not take refunds or promotions off. A tax
  level that collected tax is taxed. The other levels hold the
  non-taxed merchandise AND everything that is not merchandise (fuel,
  lottery, money orders), so::

      non taxable = untaxed levels − sales of every department whose
                    type is not merchandise

  This keeps the Sales column equal to what the register sold however
  a department is typed: a wrong type moves money between two lines,
  it never adds or loses any.
* **Every other sales line is a department TYPE** (Account →
  Departments), never a department number: number 4 is money orders
  in one store and something else in the next.
* **MCM lists only the departments that sold that day.** A type the
  store has set up that sold nothing is a register line of $0.00; a
  type the store never set up is not a register line at all.
* **All or nothing.** A department number the store has not set up
  could be lottery, fuel or merchandise, so the day stays unfilled
  until it is (``problem="departments"``).
* **MSM**: take ``payouts/total`` (the subtotal), never subtotal plus
  parts. Pay-at-pump sales are the named ``outsideFuelSales`` total.
  The file gives payment types as numbers with no names: 1 is cash
  (the safe loan row proves it), 3 and 4 are taken as the inside
  cards, 200 and up are the pay-at-pump types already inside the
  outside total. Any other number is reported in ``unplaced`` and put
  on no line.
* The register's expected cash is NOT written to Closing cash: that
  box is what a person counted.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal

from sqlalchemy import func
from sqlalchemy.orm import Session

from api.Modules.Billing.Services.feature_flags import opt_in_flag_enabled
from api.Modules.DayClose.Models import Department
from api.Modules.PosImport.Models import (
    PosFuelGradeMovement,
    PosJournalFile,
    PosMerchandiseCodeMovement,
    PosMerchandiseMap,
    PosMiscSummaryMovement,
    PosTaxLevelMovement,
)
from api.Modules.PosImport.Services.ingest import IMPORT_SOURCE
from api.Modules.PosImport.Services.movement import MOVEMENT_KIND
from api.Modules.PosImport.Services.movement_ingest import (
    day_report_rows,
    msm_roles,
)
from api.Modules.StoreBook.Models import StoreDailyEntry
from api.Modules.StoreBook.Services import (
    DayLockedError, StoreBookError, apply_import, is_locked, originals_for,
)

REGISTER_DAY_FLAG = "register_day_book"

# Department type → (daily book line, sign). A paid-out department
# reports a negative amount; its line holds the money as a positive
# figure in the Tenders column.
TYPE_LINES: dict[str, tuple[str, int]] = {
    "fuel": ("fuel_amount", 1),
    "lottery_sell": ("lottery_sales", 1),
    "lotto_sell": ("lotto_sales", 1),
    "lottery_cash": ("lotto_paid_out", -1),
    "lotto_cash": ("lotto_paid_out", -1),
    "money_order": ("money_order", 1),
    "money_order_fee": ("money_order_fee", 1),
    "money_transfer": ("money_transfer", 1),
    "money_transfer_fee": ("money_transfer_fee", 1),
    "check_cash_fee": ("check_fees", 1),
}
# Types whose sold quantity fills the "#" box beside the line.
TYPE_COUNTS: dict[str, str] = {
    "money_order": "money_order_count",
    "money_transfer": "money_transfer_count",
}
MERCHANDISE_TYPE = "merchandise"

# Payment type numbers (the register sends no names).
CASH_PAYMENT_TYPES = frozenset({"1"})
CARD_PAYMENT_TYPES = frozenset({"3", "4"})
OUTSIDE_PAYMENT_FLOOR = 200

# Why a day that has register data cannot be filled.
PROBLEM_WAITING = "waiting"          # a day report has not arrived yet
PROBLEM_DEPARTMENTS = "departments"  # a department number is not set up
PROBLEM_TAX_SPLIT = "tax_split"      # non-merchandise sales were taxed


class RegisterDayNotReady(StoreBookError):
    """The register's figures for the day cannot be used (yet)."""


@dataclass
class RegisterItem:
    """One thing the register reported that sits on no line."""
    kind: Literal["department", "payment_type"]
    code: str
    name: str
    amount_cents: int


@dataclass
class RegisterDay:
    """What the register's day close says about one business day."""
    has_data: bool = False
    ready: bool = False
    problem: str = ""
    # The register's own wall clock, as written in the reports.
    period_start: datetime | None = None
    period_end: datetime | None = None
    received_at: datetime | None = None
    # Daily book line → cents, and the "#" / gallons boxes beside them.
    values: dict[str, int] = field(default_factory=dict)
    counts: dict[str, float] = field(default_factory=dict)
    # Department numbers that sold but are not set up (blocks the day).
    unmapped: list[RegisterItem] = field(default_factory=list)
    # Reported, but on no line: an unknown payment type, a department
    # whose type has no line of its own.
    unplaced: list[RegisterItem] = field(default_factory=list)


def register_day_enabled(db: Session, store_id: int) -> bool:
    return opt_in_flag_enabled(db, store_id, REGISTER_DAY_FLAG)


def _departments_by_number(
    db: Session, store_id: int,
) -> dict[str, Department]:
    rows = (
        db.query(PosMerchandiseMap.merchandise_code, Department)
        .join(Department, Department.id == PosMerchandiseMap.department_id)
        .filter(
            PosMerchandiseMap.store_id == store_id,
            Department.store_id == store_id,
        )
        .all()
    )
    return {str(code): dept for code, dept in rows}


def _period(rows: list[Any]) -> tuple[datetime | None, datetime | None]:
    starts = [datetime.combine(r.begin_date, r.begin_time) for r in rows]
    ends = [
        datetime.combine(r.end_date or r.begin_date, r.end_time or r.begin_time)
        for r in rows
    ]
    return (min(starts) if starts else None, max(ends) if ends else None)


def _by_report(rows: list[Any]) -> list[list[Any]]:
    """Rows grouped by the report they came from, in report order."""
    groups: dict[tuple[Any, Any], list[Any]] = {}
    for r in rows:
        groups.setdefault((r.begin_date, r.begin_time), []).append(r)
    return list(groups.values())


def _payouts_cents(report: list[Any]) -> int:
    """The report's payouts, as the register signs them (negative).
    The subtotal row when there is one, else every row that is not a
    part of one: never a subtotal plus its parts."""
    rows = [r for r in report if r.summary_code == "payouts"]
    for r in rows:
        if r.summary_sub_code == "total" and r.summary_sub_code_modifier is None:
            return int(r.summary_amount_cents or 0)
    return sum(
        int(r.summary_amount_cents or 0)
        for r, role in zip(rows, msm_roles(rows))
        if role != "part"
    )


def _outside_cents(report: list[Any]) -> int | None:
    """Pay-at-pump sales, None when the report has no such total. The
    register repeats some totalizer rows, so the first one is read."""
    for r in report:
        if (
            r.summary_code == "totalizer" and r.summary_sub_code == "sales"
            and r.summary_sub_code_modifier == "outsideFuelSales"
        ):
            return int(r.summary_amount_cents or 0)
    return None


def _payment_types(report: list[Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in report:
        if r.summary_code == "sales" and r.summary_sub_code == "MOP":
            code = str(r.summary_sub_code_modifier or "").strip()
            out[code] = out.get(code, 0) + int(r.summary_amount_cents or 0)
    return out


def _is_outside_type(code: str) -> bool:
    return code.isdigit() and int(code) >= OUTSIDE_PAYMENT_FLOOR


def register_day(db: Session, store_id: int, day: date) -> RegisterDay:
    """What the register's day reports say the daily book should hold
    for ``day``. A pure read."""
    tlm = day_report_rows(db, PosTaxLevelMovement, store_id, day)
    mcm = day_report_rows(db, PosMerchandiseCodeMovement, store_id, day)
    msm = day_report_rows(db, PosMiscSummaryMovement, store_id, day)
    fgm = day_report_rows(db, PosFuelGradeMovement, store_id, day)
    out = RegisterDay()
    if not (tlm or mcm or msm or fgm):
        return out
    out.has_data = True
    out.period_start, out.period_end = _period([*tlm, *mcm, *msm, *fgm])
    out.received_at = (
        db.query(func.max(PosJournalFile.received_at))
        .filter_by(
            store_id=store_id, business_date=day, event_kind=MOVEMENT_KIND,
        )
        .scalar()
    )
    if not (tlm and mcm and msm):
        out.problem = PROBLEM_WAITING
        return out

    departments = _departments_by_number(db, store_id)

    # ── Departments ─────────────────────────────────────────
    by_type: dict[str, int] = {}
    quantity: dict[str, float] = {}
    for r in mcm:
        code = str(r.merchandise_code)
        cents = int(r.sales_amount_cents or 0)
        dept = departments.get(code)
        if dept is None:
            if cents:
                out.unmapped.append(RegisterItem(
                    kind="department", code=code,
                    name=str(r.description or ""), amount_cents=cents,
                ))
            continue
        kind = str(dept.department_type or MERCHANDISE_TYPE)
        by_type[kind] = by_type.get(kind, 0) + cents
        quantity[kind] = quantity.get(kind, 0.0) + float(r.sales_quantity or 0)
        if kind != MERCHANDISE_TYPE and kind not in TYPE_LINES and cents:
            out.unplaced.append(RegisterItem(
                kind="department", code=code, name=str(dept.name or ""),
                amount_cents=cents,
            ))
    if out.unmapped:
        out.problem = PROBLEM_DEPARTMENTS
        return out

    # ── Taxable / non taxable / tax (TLM) ───────────────────
    taxed = sum(
        int(r.taxable_sales_amount_cents or 0) for r in tlm
        if int(r.tax_collected_amount_cents or 0) != 0
    )
    untaxed = sum(
        int(r.taxable_sales_amount_cents or 0) for r in tlm
        if int(r.tax_collected_amount_cents or 0) == 0
    )
    not_merchandise = sum(
        cents for kind, cents in by_type.items() if kind != MERCHANDISE_TYPE
    )
    non_taxable = untaxed - not_merchandise
    if non_taxable < 0:
        # Fuel, lottery or a service sits in a taxed level here, so
        # the split above does not hold for this store.
        out.problem = PROBLEM_TAX_SPLIT
        return out

    values: dict[str, int] = {
        "taxable_sales": taxed,
        "non_taxable_sales": non_taxable,
        "sales_tax": sum(int(r.tax_collected_amount_cents or 0) for r in tlm),
    }

    # ── Lines by department type ────────────────────────────
    # A line is the register's when the store has a department of
    # that type, whether or not it sold today.
    store_types = {
        str(d.department_type or MERCHANDISE_TYPE)
        for d in departments.values()
    }
    for kind, (line, sign) in TYPE_LINES.items():
        if kind not in store_types:
            continue
        values[line] = values.get(line, 0) + sign * by_type.get(kind, 0)
    counts: dict[str, float] = {}
    for kind, box in TYPE_COUNTS.items():
        if kind in store_types:
            counts[box] = float(round(quantity.get(kind, 0.0)))
    if fgm and "fuel" in store_types:
        counts["fuel_gallons"] = round(
            sum(float(r.sales_volume or 0) for r in fgm), 3,
        )

    # ── Payouts and payment types (MSM) ─────────────────────
    payouts = 0
    outside: int | None = None
    payments: dict[str, int] = {}
    for report in _by_report(msm):
        payouts += _payouts_cents(report)
        report_outside = _outside_cents(report)
        if report_outside is not None:
            outside = (outside or 0) + report_outside
        for code, cents in _payment_types(report).items():
            payments[code] = payments.get(code, 0) + cents
    values["paid_out_purchases"] = -payouts
    values["cards"] = sum(
        cents for code, cents in payments.items()
        if code in CARD_PAYMENT_TYPES
    )
    if outside is not None:
        values["gas_pos_cards"] = outside
    for code in sorted(payments, key=lambda c: (len(c), c)):
        cents = payments[code]
        if (
            cents and code not in CASH_PAYMENT_TYPES
            and code not in CARD_PAYMENT_TYPES
            and not _is_outside_type(code)
        ):
            out.unplaced.append(RegisterItem(
                kind="payment_type", code=code, name="", amount_cents=cents,
            ))

    out.values = values
    out.counts = counts
    out.ready = True
    return out


def is_pending(entry: StoreDailyEntry, figures: RegisterDay) -> bool:
    """True when the register has figures the sheet has not taken:
    a line with no recorded original, or one whose original differs
    (a day never pulled, or a report the register sent again)."""
    if not figures.ready:
        return False
    recorded = originals_for(entry)
    return any(
        recorded.get(line) != cents for line, cents in figures.values.items()
    )


def pull_register_day(db: Session, entry: StoreDailyEntry) -> RegisterDay:
    """Take the register's figures onto the sheet.

    A person asked for this (opening the day, or the Refresh
    button), so a locked day refuses it like any other edit. Empty
    boxes are filled, a box somebody typed in keeps its number and
    shows the register's beside it. The caller commits.
    """
    if is_locked(entry):
        raise DayLockedError(
            "This day is locked. Unlock it before making changes.",
        )
    figures = register_day(db, int(entry.store_id), entry.entry_date)
    if not figures.ready:
        raise RegisterDayNotReady(
            "The register's day close for this day is not ready to use.",
        )
    apply_import(
        db, entry, figures.values, source=IMPORT_SOURCE,
        counts=figures.counts,
    )
    return figures


__all__ = [
    "CARD_PAYMENT_TYPES", "CASH_PAYMENT_TYPES", "PROBLEM_DEPARTMENTS",
    "PROBLEM_TAX_SPLIT", "PROBLEM_WAITING", "REGISTER_DAY_FLAG",
    "RegisterDay", "RegisterDayNotReady", "RegisterItem", "TYPE_LINES",
    "is_pending", "pull_register_day", "register_day",
    "register_day_enabled",
]
