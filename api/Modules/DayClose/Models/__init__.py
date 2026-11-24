"""DayClose — Models.

The generalized retail day-close (P1-7, HANDOFF.md §2 — the wedge).
Where the DailyBook module is the MSB cash ledger, this module
captures how a convenience store / gas station / grocery actually
closes a day: every register (or shift) prints a Z-report, and the
operator keys its totals + the department breakdown.

* ``Department``     — the store's department catalog (Grocery,
                       Tobacco, Beer, Deli…). Shared store-wide;
                       the future price book will hang items off
                       the same rows.
* ``RegisterClose``  — one register/shift Z-report for one day:
                       gross sales, sales tax, tender breakdown
                       (cash / card / other), optional counted
                       drawer cash. One row per (store, date,
                       register, shift) — re-submitting replaces.
* ``DepartmentSale`` — one department's sales line on one
                       RegisterClose: its NET for that register and
                       day, so a paid-out department (lottery cashed)
                       is a minus line. On an imported close the lines
                       add up to ``gross_sales``; never filter them to
                       the positive ones. ``store_id`` is denormalized
                       so the retention purge can sweep by store
                       like every other per-store table.

Derived, never stored (same philosophy as the daily-book O/S):
  over_short      = cash_counted − cash_total   (None until counted)
  tender_variance = (cash + card + other) − (gross + tax)

Money is integer cents from day one (P0-3 convention) — no Float
columns in this module, ever.
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger, Boolean, Column, Date, DateTime, Float, ForeignKey,
    Integer, String, UniqueConstraint, true,
)
from sqlalchemy.orm import relationship

from api.Core.Database import Base
from api.Core.Money import DollarView, to_cents, to_dollars
from api.Core.Clock import utc_now


# What kind of sales a department holds. The daily paperwork reads
# it to put each department's register total on the right line
# (lottery sales, lotto payouts, money order fees…), so the values
# match the owner's daily-entry design. Shown to the operator grouped
# the way Modisoft groups them (Merchandise, Fuel, Lottery, Services,
# Misc). Not a DB enum: a new type lands without a migration.
DEPARTMENT_TYPES: tuple[str, ...] = (
    "merchandise",
    "fuel",
    "lottery_sell", "lottery_cash", "lotto_sell", "lotto_cash",
    "money_order", "money_order_fee", "money_transfer",
    "money_transfer_fee", "check_cash_fee", "service",
    "misc",
)


class Department(Base):
    __tablename__ = "retail_department"
    id         = Column(Integer, primary_key=True)
    store_id   = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    name       = Column(String(80), nullable=False)
    # Setup fields (Account → Departments). The register's department
    # number is NOT a column here: it lives in retail_pos_merchandise_map
    # (one row per number), the table the register import already reads,
    # so there is one place that says which number is which department.
    department_type = Column(
        String(30), nullable=False, default="merchandise",
        server_default="merchandise",
    )
    is_taxable = Column(Boolean, nullable=False, default=True, server_default=true())
    # The department's own sales tax rate when it is taxable, as a
    # fraction (0.0825 = 8.25 %), like ``Store.sales_tax_rate``. NULL =
    # no rate set; always NULL for a non-taxable department.
    tax_rate   = Column(Float, nullable=True)
    # Minimum buyer age (18 lottery, 21 beer / tobacco). NULL = none.
    min_age    = Column(Integer, nullable=True)
    # NACS product category code (400 general, 411 cigarettes…).
    nacs_code  = Column(String(10), nullable=False, default="", server_default="")
    # Sub-departments (P2-4): one level deep only — a parent must
    # itself be top-level, enforced in the Service. Sales lines and
    # price-book items keep pointing at whichever department they
    # reference; the hierarchy is display/grouping, not a rollup
    # rewrite.
    parent_id  = Column(
        Integer, ForeignKey("retail_department.id"), nullable=True, index=True,
    )
    sort_order = Column(Integer, nullable=False, default=0)
    # Deactivate instead of delete — historical sales lines keep
    # their FK when a department is retired.
    is_active  = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=utc_now)
    __table_args__ = (UniqueConstraint("store_id", "name"),)

    parent = relationship("Department", remote_side=[id])


class RegisterClose(Base):
    __tablename__ = "retail_register_close"
    id             = Column(Integer, primary_key=True)
    store_id       = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    report_date    = Column(Date, nullable=False)
    # Free-form labels — "Register 1", "Front", "Morning". shift_label
    # defaults to "" (not NULL) so it participates in the unique key:
    # single-shift stores just leave it blank.
    register_label = Column(String(40), nullable=False)
    shift_label    = Column(String(40), nullable=False, default="")

    gross_sales_cents = Column(BigInteger, nullable=False, default=0)
    sales_tax_cents   = Column(BigInteger, nullable=False, default=0)
    cash_total_cents  = Column(BigInteger, nullable=False, default=0)
    card_total_cents  = Column(BigInteger, nullable=False, default=0)
    other_total_cents = Column(BigInteger, nullable=False, default=0)
    gross_sales = DollarView("gross_sales_cents")
    sales_tax   = DollarView("sales_tax_cents")
    cash_total  = DollarView("cash_total_cents")
    card_total  = DollarView("card_total_cents")
    other_total = DollarView("other_total_cents")

    # Counted drawer cash. NULL = not counted yet — DollarView would
    # coerce that to $0.00, which is a real (and very different)
    # count, so this one is a hand-written None-preserving pair.
    cash_counted_cents = Column(BigInteger, nullable=True)

    notes      = Column(String(500), nullable=False, default="")
    # Provenance: "manual" (keyed by an operator) or an import
    # source like "gilbarco" (PosImport NAXML ingest). Display
    # only — imported closes stay editable like any other.
    source     = Column(String(20), nullable=False, default="manual")
    created_by = Column(Integer, ForeignKey("tenancy_user.id"), nullable=True)
    created_at = Column(DateTime, default=utc_now)
    __table_args__ = (
        UniqueConstraint(
            "store_id", "report_date", "register_label", "shift_label",
        ),
    )

    department_sales = relationship(
        "DepartmentSale", backref="register_close",
        cascade="all, delete-orphan",
    )

    @property
    def cash_counted(self) -> float | None:
        if self.cash_counted_cents is None:
            return None
        return to_dollars(self.cash_counted_cents)

    @cash_counted.setter
    def cash_counted(self, dollars: object) -> None:
        self.cash_counted_cents = (
            None if dollars is None else to_cents(dollars)
        )

    @property
    def over_short_cents(self) -> int | None:
        """Drawer over/short: counted − expected cash tender.
        None until the drawer is actually counted."""
        if self.cash_counted_cents is None:
            return None
        return int(self.cash_counted_cents) - int(self.cash_total_cents or 0)

    @property
    def tender_variance_cents(self) -> int:
        """Tenders vs. reported sales: (cash + card + other) −
        (gross + tax). Non-zero is normal noise (paid-outs, refunds,
        rounding) — surfaced, never blocked."""
        tender = (
            int(self.cash_total_cents or 0)
            + int(self.card_total_cents or 0)
            + int(self.other_total_cents or 0)
        )
        return tender - (
            int(self.gross_sales_cents or 0) + int(self.sales_tax_cents or 0)
        )


class DepartmentSale(Base):
    __tablename__ = "retail_department_sale"
    id                = Column(Integer, primary_key=True)
    store_id          = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    register_close_id = Column(
        Integer, ForeignKey("retail_register_close.id"), nullable=False, index=True,
    )
    department_id     = Column(
        Integer, ForeignKey("retail_department.id"), nullable=False, index=True,
    )
    amount_cents      = Column(BigInteger, nullable=False, default=0)
    amount            = DollarView("amount_cents")
    __table_args__ = (
        UniqueConstraint("register_close_id", "department_id"),
    )

    department = relationship("Department")


class HourlySale(Base):
    """Store-level net sales per clock hour of one business day
    (G-3 — the dashboard's hourly-sales chart). Fed live by the
    Gilbarco agent as each journal file arrives, and rebuilt from
    the staged originals whenever the day is (re)committed, so the
    booked history is always self-consistent. ``source`` scopes
    rows the same way RegisterClose.source does — a future POS
    integration writes its own rows without colliding."""

    __tablename__ = "retail_hourly_sale"
    id           = Column(Integer, primary_key=True)
    store_id     = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    report_date  = Column(Date, nullable=False, index=True)
    hour         = Column(Integer, nullable=False)  # 0..23
    amount_cents = Column(BigInteger, nullable=False, default=0)
    amount       = DollarView("amount_cents")
    source       = Column(String(20), nullable=False, default="gilbarco")
    __table_args__ = (
        UniqueConstraint("store_id", "report_date", "hour", "source"),
    )


__all__ = [
    "DEPARTMENT_TYPES", "Department", "DepartmentSale", "HourlySale",
    "RegisterClose",
]
