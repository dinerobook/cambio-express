"""Payroll cash/check split — monthly P&L feed.

The daily book's typed ``payroll_expense`` became two line-item
kinds: ``payroll_cash`` (still a daily disbursement) and
``payroll_check`` (invisible to daily totals, feeds the monthly
``check_payroll`` P&L line). The one-shot backfill migration that
did the split is exercised by conftest's ``alembic upgrade head``.
"""
from __future__ import annotations

from datetime import date

from tests._app import db, db_session


def test_monthly_check_payroll_derives_from_daily(test_store_id):
    """MonthlyFinancial.check_payroll sums DailyReport.payroll_check
    over the month and lands in total_expenses — the whole point of
    the check-payroll kind (checks skip the daily book but must hit
    the P&L)."""
    from api.Modules.DailyBook.Models import DailyReport
    from api.Modules.Monthly.Services.write import _DAILY_DERIVED_FIELDS, _sum_daily

    assert _DAILY_DERIVED_FIELDS["check_payroll"] == "payroll_check"
    with db_session():
        db.session.add(DailyReport(
            store_id=test_store_id, report_date=date(2026, 4, 3),
            payroll_check=1200.0,
        ))
        db.session.add(DailyReport(
            store_id=test_store_id, report_date=date(2026, 4, 17),
            payroll_check=800.0,
        ))
        # A different month must not leak in.
        db.session.add(DailyReport(
            store_id=test_store_id, report_date=date(2026, 5, 1),
            payroll_check=999.0,
        ))
        db.session.commit()
        assert _sum_daily(
            db.session, test_store_id, 2026, 4,
            daily_field="payroll_check",
        ) == 2000.0


def test_check_payroll_in_monthly_total_expenses(test_store_id):
    from api.Modules.Monthly.Models import MonthlyFinancial
    with db_session():
        row = MonthlyFinancial(
            store_id=test_store_id, year=2026, month=4,
            cash_payroll=500.0, check_payroll=2000.0,
        )
        db.session.add(row)
        db.session.flush()
        assert row.total_expenses == 2500.0
