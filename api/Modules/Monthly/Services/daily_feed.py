"""What the daily books say about one month.

The monthly P&L is the month-sized view of the daily books, so most
of its lines are already known the moment a day is entered. This
module reads both books — the MSB daily book (`msb_daily_report`
plus its Services box tables) and the Store daily book
(`retail_store_daily_entry`) — and sums them for one
(store, year, month). It is a pure read: nothing here writes, so the
P&L can call it on every GET and a day typed a minute ago shows up
without anyone pressing Save (INVARIANTS.md "Daily feed").

Three families, each with its own rule:

* ``DAILY_DERIVED_FIELDS`` — always the daily books' figure once the
  month has any day entered (cash / check purchases and expenses,
  payroll, check cashing fees). The operator never types these.
* ``DAILY_FED_FIELDS`` — operator-editable lines the daily books can
  also fill (sales, bill payment and top-up fees, hold fees,
  rebates). The daily books win for a line only when they have a
  non-zero figure for it this month; otherwise the typed value
  stands, exactly like the bank feed. Presence IS the lock.
* ``DAILY_EXTRA_INCOME`` — income the daily book records that has no
  P&L column (money order fees, net of what each company charges per
  money order). Read-only lines, counted in total income, never
  stored.
"""
from __future__ import annotations

from calendar import monthrange
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import func
from sqlalchemy.orm import Session


# A source is (book, attribute):
#   "msb"     → DailyReport column
#   "store"   → StoreDailyEntry column
#   "service" → MoneyServiceSummary fees for that service kind
Source = tuple[str, str]

# MonthlyFinancial column → DailyReport column. Always derived.
# Kept as the plain MSB map because the write path and its tests
# speak in these names.
_MSB_DERIVED: dict[str, str] = {
    "cash_purchases":     "cash_purchases",
    "check_purchases":    "check_purchases",
    "cash_expenses":      "cash_expense",     # singular on DailyReport
    "check_expenses":     "check_expense",
    "cash_payroll":       "payroll_expense",
    "check_payroll":      "payroll_check",
    "check_cashing_fees": "check_cashing_fees",
}
# The Store daily book's twin of each derived line, where it has one:
# its "Paid out" box is cash out of the register, its "Paid by check"
# box is checks written.
_STORE_DERIVED: dict[str, str] = {
    "cash_purchases":     "paid_out_purchases",
    "check_purchases":    "check_paid_purchases",
    "cash_expenses":      "paid_out_expenses",
    "check_expenses":     "check_paid_expenses",
    "check_payroll":      "check_paid_payroll",
    "check_cashing_fees": "check_fees",
}

DAILY_DERIVED_FIELDS: dict[str, tuple[Source, ...]] = {
    col: (("msb", msb),) + (
        (("store", _STORE_DERIVED[col]),) if col in _STORE_DERIVED else ()
    )
    for col, msb in _MSB_DERIVED.items()
}

DAILY_FED_FIELDS: dict[str, tuple[Source, ...]] = {
    "taxable_sales": (("msb", "taxable_sales"), ("store", "taxable_sales")),
    "non_taxable":   (("msb", "non_taxable"), ("store", "non_taxable_sales")),
    # The Services box's fee per service, plus the retired typed boxes
    # that older days still carry.
    "bill_payment_charge": (
        ("msb", "bill_payment_charge"), ("service", "bill_payment"),
    ),
    "phone_recargas": (
        ("msb", "phone_recargas"),
        ("service", "top_up"), ("service", "recharge"),
    ),
    "boost_mobile":           (("msb", "boost_mobile"),),
    "return_check_hold_fees": (("msb", "return_check_hold_fees"),),
    "rebates_commissions":    (("msb", "rebates_commissions"),),
}

# Money transfer fees are deliberately NOT here: the companies pay the
# store's share as a commission deposit at the start of the next
# month, which reaches the P&L as `mt_commission_in_bank` (typed or
# tagged from the bank). Counting the fees too would count it twice.
DAILY_EXTRA_INCOME: dict[str, tuple[Source, ...]] = {
    "money_order_fees": (
        ("msb", "money_order_fees"), ("service", "money_order"),
    ),
}


@dataclass
class DailyFeed:
    """The daily books' figures for one month.

    ``days`` counts the distinct dates entered in either book.
    ``derived`` is empty when ``days`` is 0 so a month that predates
    the daily book keeps whatever was saved on it. ``fed`` holds only
    the lines with a non-zero figure. ``extra`` carries every
    ``DAILY_EXTRA_INCOME`` line once the month has a day entered."""
    days: int = 0
    derived: dict[str, float] = field(default_factory=dict)
    fed: dict[str, float] = field(default_factory=dict)
    extra: dict[str, float] = field(default_factory=dict)
    # Money orders counted on the Services box this month, and what
    # the companies charge for them (count × each company's
    # per-order charge from Settings). Already taken off
    # ``extra["money_order_fees"]``; carried for display.
    money_order_count: int = 0
    money_order_charges: float = 0.0


def month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, monthrange(year, month)[1])


def _cents_sums(
    db: Session, model: type, date_col: str, store_id: int,
    start: date, end: date, attrs: set[str],
) -> dict[str, int]:
    """Σ ``<attr>_cents`` for each attr over the month, one query."""
    if not attrs:
        return {}
    names = sorted(attrs)
    d = getattr(model, date_col)
    row = (
        db.query(*[
            func.coalesce(func.sum(getattr(model, f"{a}_cents")), 0)
            for a in names
        ])
        .filter(model.store_id == store_id, d >= start, d <= end)
        .one()
    )
    return {a: int(v or 0) for a, v in zip(names, row)}


def _entered_days(
    db: Session, store_id: int, start: date, end: date,
) -> int:
    from api.Modules.DailyBook.Models import DailyReport
    from api.Modules.StoreBook.Models import StoreDailyEntry

    msb = {
        d for (d,) in db.query(DailyReport.report_date).filter(
            DailyReport.store_id == store_id,
            DailyReport.report_date >= start,
            DailyReport.report_date <= end,
        )
    }
    store = {
        d for (d,) in db.query(StoreDailyEntry.entry_date).filter(
            StoreDailyEntry.store_id == store_id,
            StoreDailyEntry.entry_date >= start,
            StoreDailyEntry.entry_date <= end,
        )
    }
    return len(msb | store)


def daily_feed_for_month(
    db: Session, store_id: int, year: int, month: int,
) -> DailyFeed:
    """Sum both daily books for the month. Pure read."""
    from api.Modules.DailyBook.Models import DailyReport, MoneyServiceSummary
    from api.Modules.StoreBook.Models import StoreDailyEntry

    start, end = month_bounds(year, month)
    days = _entered_days(db, store_id, start, end)
    if days == 0:
        return DailyFeed()

    families = (DAILY_DERIVED_FIELDS, DAILY_FED_FIELDS, DAILY_EXTRA_INCOME)
    wanted: dict[str, set[str]] = {"msb": set(), "store": set()}
    for family in families:
        for sources in family.values():
            for book, attr in sources:
                if book in wanted:
                    wanted[book].add(attr)

    sums: dict[str, dict[str, int]] = {
        "msb": _cents_sums(db, DailyReport, "report_date", store_id,
                           start, end, wanted["msb"]),
        "store": _cents_sums(db, StoreDailyEntry, "entry_date", store_id,
                             start, end, wanted["store"]),
        "service": {
            str(svc): int(c or 0)
            for svc, c in db.query(
                MoneyServiceSummary.service,
                func.coalesce(func.sum(MoneyServiceSummary.fees_cents), 0),
            ).filter(
                MoneyServiceSummary.store_id == store_id,
                MoneyServiceSummary.report_date >= start,
                MoneyServiceSummary.report_date <= end,
            ).group_by(MoneyServiceSummary.service)
        },
    }

    def total(sources: tuple[Source, ...]) -> float:
        cents = sum(sums[book].get(attr, 0) for book, attr in sources)
        return round(cents / 100.0, 2)

    fed = {col: total(src) for col, src in DAILY_FED_FIELDS.items()}
    extra = {col: total(src) for col, src in DAILY_EXTRA_INCOME.items()}
    count, charges = _money_order_charges(db, store_id, start, end)
    extra["money_order_fees"] = round(extra["money_order_fees"] - charges, 2)
    return DailyFeed(
        days=days,
        derived={col: total(src) for col, src in DAILY_DERIVED_FIELDS.items()},
        fed={col: v for col, v in fed.items() if v != 0},
        extra=extra,
        money_order_count=count,
        money_order_charges=charges,
    )


def _money_order_charges(
    db: Session, store_id: int, start: date, end: date,
) -> tuple[int, float]:
    """(money orders counted, what the companies charge for them).

    What the store charges on top of a money order is its own; the
    company takes the face value plus its per-order charge from the
    bank (owner, 2026-10-20). So the P&L's money order income is the
    fees less Σ count × charge, per company. A company with no charge
    in Settings, or a day with no count, takes nothing off."""
    from api.Modules.DailyBook.Models import MoneyServiceSummary
    from api.Modules.Tenancy.Models import Store
    from api.Modules.Transfers.Services import store_money_order_charges

    per_company = (
        db.query(
            MoneyServiceSummary.company,
            func.coalesce(func.sum(MoneyServiceSummary.item_count), 0),
        )
        .filter(
            MoneyServiceSummary.store_id == store_id,
            MoneyServiceSummary.service == "money_order",
            MoneyServiceSummary.report_date >= start,
            MoneyServiceSummary.report_date <= end,
        )
        .group_by(MoneyServiceSummary.company)
        .all()
    )
    count = sum(int(n or 0) for _co, n in per_company)
    if count == 0:
        return 0, 0.0
    rates = store_money_order_charges(db.get(Store, store_id))
    charges = sum(
        int(n or 0) * rates.get(str(co).strip().lower(), 0.0)
        for co, n in per_company
    )
    return count, round(charges, 2)


def months_with_daily_entries(
    db: Session, store_id: int,
) -> set[tuple[int, int]]:
    """Every (year, month) with at least one day in either book."""
    from api.Modules.DailyBook.Models import DailyReport
    from api.Modules.StoreBook.Models import StoreDailyEntry

    out: set[tuple[int, int]] = set()
    for (d,) in (
        db.query(DailyReport.report_date)
          .filter(DailyReport.store_id == store_id).distinct()
    ):
        out.add((d.year, d.month))
    for (d,) in (
        db.query(StoreDailyEntry.entry_date)
          .filter(StoreDailyEntry.store_id == store_id).distinct()
    ):
        out.add((d.year, d.month))
    return out
