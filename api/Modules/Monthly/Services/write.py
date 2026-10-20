"""Monthly P&L write Service.

Mirrors the legacy `/monthly/<year>/<month>` POST handler.

The tricky bit is auto-derived fields: certain monthly columns
must equal the sum of the underlying daily-book / bank-charge /
return-check rows. The server enforces them on save so a stale
form submission (or a tampered POST) can't drift the monthly
P&L away from the daily ledger.

Auto-derived fields:
  cash_purchases, check_purchases, cash_expenses, check_expenses,
  cash_payroll, check_payroll, check_cashing_fees → sums from both
  daily books over the month; sales, service fees, hold fees and
  rebates too when the daily books have a figure for them
  (`daily_feed.py` owns the map).
  return_check_gl → net P&L from the ReturnCheck workflow.
  bank-fed lines → `bank_charges_total` (every bank_charge slug)
  plus any column a `pl_*` bank category feeds (credit-card
  fees, money-order rent, other income…). Each is locked ONLY
  for a month where the bank has tagged rows for it; otherwise
  the operator's typed value stands. `bank_pl_sums_for_month`
  is the single source of that set.

Operator-editable fields: everything else in `_DAILY_REPORT_FIELDS`
plus the dozens of one-off P&L columns.
"""
from sqlalchemy.orm import Session

from api.Modules.Monthly.Models import MonthlyFinancial
from api.Modules.Monthly.Services.daily_feed import daily_feed_for_month
from api.Core.Clock import utc_now


# Fields the operator can write directly. Auto-derived fields
# below are filtered out before setattr so a tampered POST
# can't override the truth.
EDITABLE_MONTHLY_FIELDS: tuple[str, ...] = (
    "taxable_sales", "non_taxable",
    "bill_payment_charge", "phone_recargas", "boost_mobile",
    "return_check_hold_fees", "rebates_commissions",
    "mt_commission_in_bank",
    "other_income_1", "other_income_2", "other_income_3",
    "credit_card_fees",
    "money_order_rent", "emaginenet_tech",
    "irs_payroll_tax", "texas_workforce", "other_taxes",
    "accounting_charges",
    "other_expense_1", "other_expense_2", "other_expense_3",
    "other_expense_4", "other_expense_5",
    "over_short", "borrowed_money_return", "profit_distributed",
    "cash_carry_forward",
)


def _auto_return_check_gl(
    db: Session, store_id: int, year: int, month: int,
) -> float:
    """Net Return Check (G/L) value for the monthly P&L."""
    from api.Modules.Owners.Services import return_check_monthly_pl
    return float(return_check_monthly_pl(db, store_id, year, month) or 0)


def bank_fed_fields(
    db: Session, store_id: int, year: int, month: int,
) -> dict[str, float]:
    """MonthlyFinancial column → the bank feed's sum for the month,
    for every column the bank has tagged rows for. Absent columns
    are the operator's to type. Shared by the write path (which
    applies them) and the read path (which reports them as
    `bank_locked`)."""
    from api.Modules.BankSync.Services import bank_pl_sums_for_month
    return bank_pl_sums_for_month(db, store_id, year, month)


def update_monthly(
    db: Session, *,
    store_id: int, year: int, month: int,
    fields: dict[str, float], notes: str = "",
) -> MonthlyFinancial:
    """Save the editable monthly fields. Auto-derives the
    daily-summed + return-check-net + bank-charge fields server-
    side, overwriting client-supplied values for those.

    Auto-creates the MonthlyFinancial row when missing (matches
    the legacy POST behavior). Caller commits.
    """
    row = (
        db.query(MonthlyFinancial)
          .filter_by(store_id=store_id, year=year, month=month)
          .first()
    )
    if row is None:
        row = MonthlyFinancial(
            store_id=store_id, year=year, month=month,
        )
        db.add(row)
        db.flush()

    # 1) Apply operator-editable fields.
    for field in EDITABLE_MONTHLY_FIELDS:
        if field in fields and fields[field] is not None:
            setattr(row, field, float(fields[field]))

    # 2) Daily books: the derived lines always, once the month has a
    #    day in either book (a month that predates the daily book
    #    keeps what was saved on it); then every operator line the
    #    daily books have a figure for — the same sums the read side
    #    shows (`daily_feed.py`).
    feed = daily_feed_for_month(db, store_id, year, month)
    for field, value in {**feed.derived, **feed.fed}.items():
        setattr(row, field, float(value))

    # 3) Overwrite return_check_gl from the workflow.
    setattr(row, "return_check_gl", _auto_return_check_gl(
        db, store_id, year, month,
    ))

    # 4) Bank-fed lines: the bank's sum wins for every column it has
    #    tagged rows for this month. Columns it is silent on keep
    #    the operator's value (applied in step 1, or the legacy
    #    `bank_charges_total` manual entry below) — stores without
    #    bank sync keep typing.
    fed = bank_fed_fields(db, store_id, year, month)
    for field, value in fed.items():
        setattr(row, field, float(value))
    if (
        "bank_charges_total" not in fed
        and fields.get("bank_charges_total") is not None
    ):
        setattr(row, "bank_charges_total", float(fields["bank_charges_total"]))

    setattr(row, "notes", notes or "")
    setattr(row, "updated_at", utc_now())
    db.flush()
    return row
