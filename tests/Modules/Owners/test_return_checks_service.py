"""Unit tests for Owners.Services.return_checks (PR 62)."""
from datetime import date, timedelta

from api.Modules.DailyBook.Models import DailyReport
from api.Modules.ReturnChecks.Models import ReturnCheck, ReturnCheckPayment
from api.Modules.Tenancy.Models import Store
from api.Modules.Transfers.Models import Transfer
from tests._app import db, db_session


def _add_store(db, slug="rc-store"):
    s = Store(name=slug, slug=slug, plan="basic",
              email=f"{slug}@example.com")
    db.add(s); db.flush()
    return s


def _add_check(db, store_id, *, bounced_on, amount=500.0,
                status="pending", status_changed_on=None):
    rc = ReturnCheck(
        store_id=store_id,
        customer_name="Test Customer",
        check_number="CHK-1",
        amount=amount,
        bounced_on=bounced_on,
        status=status,
        status_changed_on=status_changed_on,
    )
    db.add(rc); db.flush()
    return rc


def _add_payment(db, return_check_id, *, paid_on, amount=100.0):
    p = ReturnCheckPayment(
        return_check_id=return_check_id,
        amount=amount,
        paid_on=paid_on,
    )
    db.add(p); db.flush()
    return p


# ── writeoff_total ─────────────────────────────────────────


def test_writeoff_empty_store_ids_returns_zero():
    from tests._app import db
    from api.Modules.Owners.Services import return_check_writeoff_total
    with db_session():
        result = return_check_writeoff_total(
            db.session, [], date(2026, 1, 1), date(2026, 12, 31), "loss",
        )
        assert result == 0.0


def test_writeoff_nets_payments_against_remaining_balance():
    """A $500 check with $100 paid before loss → $400 writeoff."""
    from tests._app import db
    from api.Modules.Owners.Services import return_check_writeoff_total
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.query(ReturnCheckPayment).delete()
        db.session.commit()
        s = _add_store(db.session)
        rc = _add_check(
            db.session, s.id,
            bounced_on=date(2026, 1, 10),
            amount=500.0,
            status="loss",
            status_changed_on=date(2026, 5, 1),
        )
        _add_payment(
            db.session, rc.id,
            paid_on=date(2026, 2, 1), amount=100.0,
        )
        total = return_check_writeoff_total(
            db.session, [s.id],
            date(2026, 5, 1), date(2026, 5, 31), "loss",
        )
        assert total == 400.0


def test_writeoff_filters_by_status_value():
    """A check marked 'fraud' isn't included when status_value='loss'."""
    from tests._app import db
    from api.Modules.Owners.Services import return_check_writeoff_total
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.commit()
        s = _add_store(db.session, slug="fraud-store")
        _add_check(
            db.session, s.id,
            bounced_on=date(2026, 1, 1),
            amount=300.0,
            status="fraud",
            status_changed_on=date(2026, 5, 1),
        )
        loss_total = return_check_writeoff_total(
            db.session, [s.id],
            date(2026, 5, 1), date(2026, 5, 31), "loss",
        )
        assert loss_total == 0.0


def test_writeoff_filters_by_status_changed_window():
    """Loss outside window → excluded."""
    from tests._app import db
    from api.Modules.Owners.Services import return_check_writeoff_total
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.commit()
        s = _add_store(db.session, slug="window-store")
        _add_check(
            db.session, s.id,
            bounced_on=date(2026, 1, 1),
            amount=200.0,
            status="loss",
            status_changed_on=date(2026, 3, 1),  # March
        )
        # Window is May
        total = return_check_writeoff_total(
            db.session, [s.id],
            date(2026, 5, 1), date(2026, 5, 31), "loss",
        )
        assert total == 0.0


# ── period_aggregates ──────────────────────────────────────


def test_period_aggregates_empty_store_ids_returns_zeros():
    from tests._app import db
    from api.Modules.Owners.Services import (
        return_check_period_aggregates,
    )
    with db_session():
        result = return_check_period_aggregates(
            db.session, [], date(2026, 1, 1), date(2026, 12, 31),
        )
        assert result == {
            "recoveries": 0.0, "fee_income": 0.0, "losses": 0.0,
            "fraud": 0.0, "net_gl": 0.0, "pending": 0.0, "pending_count": 0,
        }


def test_period_aggregates_recoveries_by_payment_date():
    """Recoveries are measured at the PAYMENT level — installments
    in different months go to different months."""
    from tests._app import db
    from api.Modules.Owners.Services import (
        return_check_period_aggregates,
    )
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.query(ReturnCheckPayment).delete()
        db.session.commit()
        s = _add_store(db.session, slug="recovery-store")
        rc = _add_check(
            db.session, s.id,
            bounced_on=date(2026, 1, 10), amount=1000.0,
        )
        # April installment: 300
        _add_payment(db.session, rc.id, paid_on=date(2026, 4, 5),
                     amount=300.0)
        # May installment: 400
        _add_payment(db.session, rc.id, paid_on=date(2026, 5, 12),
                     amount=400.0)
        # April-only window
        agg = return_check_period_aggregates(
            db.session, [s.id], date(2026, 4, 1), date(2026, 4, 30),
        )
        assert agg["recoveries"] == 300.0
        # May-only window
        agg = return_check_period_aggregates(
            db.session, [s.id], date(2026, 5, 1), date(2026, 5, 31),
        )
        assert agg["recoveries"] == 400.0


def test_period_aggregates_pending_balance_subtracts_installments():
    """Pending = parent.amount − payments already received."""
    from tests._app import db
    from api.Modules.Owners.Services import (
        return_check_period_aggregates,
    )
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.query(ReturnCheckPayment).delete()
        db.session.commit()
        s = _add_store(db.session, slug="pending-store")
        rc = _add_check(
            db.session, s.id,
            bounced_on=date(2026, 1, 10), amount=1000.0,
        )
        _add_payment(db.session, rc.id,
                     paid_on=date(2026, 2, 1), amount=200.0)
        agg = return_check_period_aggregates(
            db.session, [s.id], date(2026, 1, 1), date(2026, 12, 31),
        )
        # Outstanding = 1000 - 200 = 800
        assert agg["pending"] == 800.0
        assert agg["pending_count"] == 1


def test_period_aggregates_net_gl_uses_gain_positive():
    """net_gl = fee income - (losses + fraud). Cash paid back up to
    the face amount is reported as a recovery but is not a gain."""
    from tests._app import db
    from api.Modules.Owners.Services import (
        return_check_period_aggregates,
    )
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.query(ReturnCheckPayment).delete()
        db.session.commit()
        s = _add_store(db.session, slug="netgl-store")
        # Recovered $500 in May
        rec_check = _add_check(
            db.session, s.id, bounced_on=date(2026, 1, 1),
            amount=600.0,
        )
        _add_payment(db.session, rec_check.id,
                     paid_on=date(2026, 5, 5), amount=500.0)
        # Lost $200 in May
        _add_check(
            db.session, s.id, bounced_on=date(2026, 1, 1),
            amount=200.0, status="loss",
            status_changed_on=date(2026, 5, 10),
        )
        agg = return_check_period_aggregates(
            db.session, [s.id], date(2026, 5, 1), date(2026, 5, 31),
        )
        assert agg["recoveries"] == 500.0
        assert agg["fee_income"] == 0.0   # 500 of a 600 check: no fee yet
        assert agg["losses"] == 200.0
        assert agg["fraud"] == 0.0
        assert agg["net_gl"] == -200.0  # 0 fees - 200 - 0


def test_full_payback_is_not_a_gain():
    """The reported bug: $11,579.75 of bounced checks fully paid
    back showed as an $11,579.75 gain. Getting the face amount back
    is the store's own money returning — the month's P&L line is 0."""
    from tests._app import db
    from api.Modules.Owners.Services import (
        return_check_monthly_pl,
        return_check_period_aggregates,
    )
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.query(ReturnCheckPayment).delete()
        db.session.commit()
        s = _add_store(db.session, slug="payback-store")
        a = _add_check(db.session, s.id, bounced_on=date(2026, 9, 2),
                       amount=11000.0, status="recovered",
                       status_changed_on=date(2026, 9, 20))
        b = _add_check(db.session, s.id, bounced_on=date(2026, 9, 3),
                       amount=579.75, status="recovered",
                       status_changed_on=date(2026, 9, 21))
        _add_payment(db.session, a.id, paid_on=date(2026, 9, 10), amount=6000.0)
        _add_payment(db.session, a.id, paid_on=date(2026, 9, 20), amount=5000.0)
        _add_payment(db.session, b.id, paid_on=date(2026, 9, 21), amount=579.75)
        agg = return_check_period_aggregates(
            db.session, [s.id], date(2026, 9, 1), date(2026, 9, 30),
        )
        assert agg["recoveries"] == 11579.75   # cash back, still reported
        assert agg["fee_income"] == 0.0
        assert agg["net_gl"] == 0.0
        assert return_check_monthly_pl(db.session, s.id, 2026, 9) == 0.0


def test_fee_on_top_of_face_amount_is_the_gain_in_the_month_paid():
    """Paybacks pay the face amount first; what lands above it is the
    returned-check fee, and it counts in the month it was paid."""
    from tests._app import db
    from api.Modules.Owners.Services import (
        return_check_monthly_pl,
        return_check_period_aggregates,
    )
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.query(ReturnCheckPayment).delete()
        db.session.commit()
        s = _add_store(db.session, slug="fee-store")
        rc = _add_check(db.session, s.id, bounced_on=date(2026, 4, 1),
                        amount=300.0)
        # April: 250 of the 300 face. May: 50 face + 25 fee, then 5 more fee.
        _add_payment(db.session, rc.id, paid_on=date(2026, 4, 20), amount=250.0)
        _add_payment(db.session, rc.id, paid_on=date(2026, 5, 3), amount=75.0)
        _add_payment(db.session, rc.id, paid_on=date(2026, 5, 9), amount=5.0)
        april = return_check_period_aggregates(
            db.session, [s.id], date(2026, 4, 1), date(2026, 4, 30),
        )
        may = return_check_period_aggregates(
            db.session, [s.id], date(2026, 5, 1), date(2026, 5, 31),
        )
        assert (april["recoveries"], april["fee_income"]) == (250.0, 0.0)
        assert (may["recoveries"], may["fee_income"]) == (80.0, 30.0)
        # Expense convention: a gain is negative on the P&L line.
        assert return_check_monthly_pl(db.session, s.id, 2026, 5) == -30.0
        assert return_check_monthly_pl(db.session, s.id, 2026, 4) == 0.0


def test_fee_income_is_scoped_to_the_stores_asked_for():
    from tests._app import db
    from api.Modules.Owners.Services.return_checks import fee_income
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.query(ReturnCheckPayment).delete()
        db.session.commit()
        mine = _add_store(db.session, slug="fee-mine")
        other = _add_store(db.session, slug="fee-other")
        rc = _add_check(db.session, other.id, bounced_on=date(2026, 5, 1),
                        amount=100.0)
        _add_payment(db.session, rc.id, paid_on=date(2026, 5, 2), amount=120.0)
        window = (date(2026, 5, 1), date(2026, 5, 31))
        assert fee_income(db.session, [mine.id], *window) == 0.0
        assert fee_income(db.session, [other.id], *window) == 20.0
        assert fee_income(db.session, [], *window) == 0.0


# ── aging_buckets ──────────────────────────────────────────


def test_aging_buckets_empty_store_ids_returns_zero_buckets():
    from tests._app import db
    from api.Modules.Owners.Services import return_check_aging_buckets
    with db_session():
        result = return_check_aging_buckets(
            db.session, [], today=date(2026, 5, 6),
        )
        labels = [b["label"] for b in result]
        assert labels == ["0–30 d", "31–60 d", "61–90 d", "90+ d"]
        assert all(b["amount"] == 0.0 and b["count"] == 0 for b in result)


def test_aging_buckets_classifies_by_age():
    from tests._app import db
    from api.Modules.Owners.Services import return_check_aging_buckets
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.commit()
        s = _add_store(db.session, slug="aging-store")
        today = date(2026, 5, 6)
        # 5 days old → 0–30
        _add_check(db.session, s.id,
                   bounced_on=today - timedelta(days=5),
                   amount=100.0)
        # 45 days old → 31–60
        _add_check(db.session, s.id,
                   bounced_on=today - timedelta(days=45),
                   amount=200.0)
        # 100 days old → 90+
        _add_check(db.session, s.id,
                   bounced_on=today - timedelta(days=100),
                   amount=300.0)
        buckets = return_check_aging_buckets(
            db.session, [s.id], today=today,
        )
        by_label = {b["label"]: b for b in buckets}
        assert by_label["0–30 d"]["amount"] == 100.0
        assert by_label["0–30 d"]["count"] == 1
        assert by_label["31–60 d"]["amount"] == 200.0
        assert by_label["61–90 d"]["count"] == 0
        assert by_label["90+ d"]["amount"] == 300.0


# ── monthly_series ─────────────────────────────────────────


def test_monthly_series_returns_12_months():
    from tests._app import db
    from api.Modules.Owners.Services import return_check_monthly_series
    with db_session():
        labels, rec, loss = return_check_monthly_series(
            db.session, [], today=date(2026, 5, 6),
        )
        assert len(labels) == 12
        assert len(rec) == 12
        assert len(loss) == 12
        # Newest is current month
        assert labels[-1] == "2026-05"
        assert labels[0] == "2025-06"


def test_monthly_series_handles_year_rollover():
    from tests._app import db
    from api.Modules.Owners.Services import return_check_monthly_series
    with db_session():
        labels, _, _ = return_check_monthly_series(
            db.session, [], today=date(2026, 1, 15),
        )
        # Going back 12 months from January 2026 → starts at Feb 2025
        assert labels[0] == "2025-02"
        assert labels[-1] == "2026-01"


# ── monthly_pl ─────────────────────────────────────────────


def test_monthly_pl_uses_loss_positive_convention():
    """net_gl is gain-positive; monthly_pl is loss-positive (expense
    convention). The two should be exact negatives."""
    from tests._app import db
    from api.Modules.Owners.Services import (
        return_check_monthly_pl,
        return_check_period_aggregates,
    )
    with db_session():
        db.session.query(ReturnCheck).delete()
        db.session.query(ReturnCheckPayment).delete()
        db.session.commit()
        s = _add_store(db.session, slug="pl-store")
        # $300 loss in May
        _add_check(
            db.session, s.id, bounced_on=date(2026, 1, 1),
            amount=300.0, status="loss",
            status_changed_on=date(2026, 5, 5),
        )
        pl = return_check_monthly_pl(db.session, s.id, 2026, 5)
        assert pl == 300.0  # positive expense

        agg = return_check_period_aggregates(
            db.session, [s.id], date(2026, 5, 1), date(2026, 5, 31),
        )
        assert agg["net_gl"] == -300.0  # negative gain
        assert pl == -agg["net_gl"]


# ── legacy Flask wrappers ──────────────────────────────────










