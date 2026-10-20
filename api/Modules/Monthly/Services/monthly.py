"""Monthly P&L service.

Computes total_income, total_expenses, and net_profit for a
MonthlyFinancial row so the SPA controller doesn't have to
duplicate the math (and the same totals power the legacy
template).
"""
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from api.Modules.Monthly.Models import MonthlyFinancial
from api.Modules.Monthly.Repositories import find_monthly_for
from api.Modules.Monthly.Services.daily_feed import (
    DAILY_EXTRA_INCOME,
    DailyFeed,
    daily_feed_for_month,
)


# Field categorisation. Same buckets as the legacy template's
# Total Income / Total Expenses headers — single source.
INCOME_FIELDS: tuple[str, ...] = (
    "taxable_sales", "non_taxable",
    "bill_payment_charge", "phone_recargas", "boost_mobile",
    "check_cashing_fees", "return_check_hold_fees",
    "rebates_commissions", "mt_commission_in_bank",
    "other_income_1", "other_income_2", "other_income_3",
    # Daily-book income with no stored column (daily_feed.py).
    *DAILY_EXTRA_INCOME,
)
EXPENSE_FIELDS: tuple[str, ...] = (
    "cash_purchases", "check_purchases",
    "cash_expenses", "check_expenses", "cash_payroll",
    "check_payroll",
    "bank_charges_total", "credit_card_fees",
    "money_order_rent", "emaginenet_tech",
    "irs_payroll_tax", "texas_workforce", "other_taxes",
    "accounting_charges", "return_check_gl",
    "other_expense_1", "other_expense_2", "other_expense_3",
    "other_expense_4", "other_expense_5",
    "over_short", "borrowed_money_return", "profit_distributed",
)

# The purchase lines inside EXPENSE_FIELDS, for roll-ups that show
# purchases as their own column (owner P&L roll-up).
PURCHASE_FIELDS: tuple[str, ...] = ("cash_purchases", "check_purchases")


@dataclass
class MonthlySummary:
    """Service-layer DTO. The Controller converts this into the
    Pydantic response model.

    Every figure is LIVE ("trust the ledger, never the stored
    value"): a day entered or a transaction tagged after the last
    save shows without a re-save, and the totals include it. In
    order of precedence, a line reads:

    1. ``bank_fed`` — the bank feed's sum, for every line the bank
       is speaking for this month;
    2. ``daily.fed`` / ``daily.derived`` / ``daily.extra`` — the
       daily books (see ``daily_feed.py``);
    3. ``return_check_gl`` — the return-check workflow, when given;
    4. the stored value on ``row``.

    ``saved`` is False when no row exists yet and ``row`` is an
    unsaved placeholder that only carries zeros."""
    row: MonthlyFinancial
    total_income: float
    total_expenses: float
    bank_fed: dict[str, float] = field(default_factory=dict)
    daily: DailyFeed = field(default_factory=DailyFeed)
    return_check_gl: float | None = None
    saved: bool = True

    @property
    def net_profit(self) -> float:
        return round(self.total_income - self.total_expenses, 2)

    @property
    def total_purchases(self) -> float:
        """The purchase lines of the EXPENSE bucket (already inside
        ``total_expenses``) — for views that show them on their own."""
        return _sum_fields(self, PURCHASE_FIELDS)

    @property
    def daily_fed(self) -> list[str]:
        """Every line whose figure comes from the daily books this
        month (and not the bank) — rendered read-only, "From daily
        book"."""
        d = self.daily
        return sorted(
            (set(d.fed) | set(d.derived) | set(d.extra)) - set(self.bank_fed)
        )

    def value(self, name: str) -> float:
        """The live value of a line (precedence in the class doc)."""
        if name in self.bank_fed:
            return float(self.bank_fed[name])
        for source in (self.daily.fed, self.daily.derived, self.daily.extra):
            if name in source:
                return float(source[name])
        if name == "return_check_gl" and self.return_check_gl is not None:
            return float(self.return_check_gl)
        return float(getattr(self.row, name, 0) or 0)


def _sum_fields(summary: MonthlySummary, fields: tuple[str, ...]) -> float:
    return round(sum(summary.value(f) for f in fields), 2)


def summarize_monthly(
    db: Session, store_id: int, year: int, month: int,
) -> MonthlySummary | None:
    """Return a live MonthlySummary for the (store, year, month).

    A month nobody has saved still has a P&L as soon as anything
    feeds it — a day in either daily book, a tagged bank row or
    return-check activity. Only a month with none of that and no
    saved row returns None. Pure read: the placeholder row for an
    unsaved month is never added to the session."""
    from api.Modules.Monthly.Services.write import (
        _auto_return_check_gl, bank_fed_fields,
    )

    row = find_monthly_for(db, store_id, year, month)
    daily = daily_feed_for_month(db, store_id, year, month)
    bank = bank_fed_fields(db, store_id, year, month)
    rc_gl = _auto_return_check_gl(db, store_id, year, month)
    if row is None and daily.days == 0 and not bank and rc_gl == 0:
        return None
    summary = MonthlySummary(
        row=row if row is not None else MonthlyFinancial(
            store_id=store_id, year=year, month=month,
        ),
        total_income=0.0, total_expenses=0.0,
        bank_fed=bank, daily=daily,
        # A saved month keeps its stored figure when the workflow
        # has nothing for it (a month that predates the workflow).
        return_check_gl=rc_gl if (row is None or rc_gl != 0) else None,
        saved=row is not None,
    )
    summary.total_income = _sum_fields(summary, INCOME_FIELDS)
    summary.total_expenses = _sum_fields(summary, EXPENSE_FIELDS)
    return summary
