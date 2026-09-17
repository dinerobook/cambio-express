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


# Field categorisation. Same buckets as the legacy template's
# Total Income / Total Expenses headers — single source.
INCOME_FIELDS: tuple[str, ...] = (
    "taxable_sales", "non_taxable",
    "bill_payment_charge", "phone_recargas", "boost_mobile",
    "check_cashing_fees", "return_check_hold_fees",
    "rebates_commissions", "mt_commission_in_bank",
    "other_income_1", "other_income_2", "other_income_3",
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


@dataclass
class MonthlySummary:
    """Service-layer DTO. The Controller converts this into the
    Pydantic response model.

    `bank_fed` is column → the bank feed's current sum for every
    line the bank is speaking for this month. The totals are
    computed over the row WITH those values substituted, so a
    transaction tagged after the last save shows on the P&L
    without a re-save ("trust the ledger, never the stored
    value"). The columns are what the SPA renders read-only."""
    row: MonthlyFinancial
    total_income: float
    total_expenses: float
    bank_fed: dict[str, float] = field(default_factory=dict)

    @property
    def net_profit(self) -> float:
        return round(self.total_income - self.total_expenses, 2)

    def value(self, name: str) -> float:
        """The live value of a column: the bank's sum when it feeds
        the line this month, else the stored value."""
        if name in self.bank_fed:
            return float(self.bank_fed[name])
        return float(getattr(self.row, name, 0) or 0)


def _sum_fields(summary: MonthlySummary, fields: tuple[str, ...]) -> float:
    return round(sum(summary.value(f) for f in fields), 2)


def summarize_monthly(
    db: Session, store_id: int, year: int, month: int,
) -> MonthlySummary | None:
    """Return a MonthlySummary for the (store, year, month) or
    None when no row has been logged for that month."""
    from api.Modules.Monthly.Services.write import bank_fed_fields

    row = find_monthly_for(db, store_id, year, month)
    if row is None:
        return None
    summary = MonthlySummary(
        row=row, total_income=0.0, total_expenses=0.0,
        bank_fed=bank_fed_fields(db, store_id, year, month),
    )
    summary.total_income = _sum_fields(summary, INCOME_FIELDS)
    summary.total_expenses = _sum_fields(summary, EXPENSE_FIELDS)
    return summary
