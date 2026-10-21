"""The twelve drill-down report routes under /api/v2/reports/<slug>.

Each service has unit tests; these pin the HTTP contract the SPA's
report pages read: seeded rows come back as the right numbers in the
`{rows, totals}` envelope, rows outside the period stay out, and the
`reports.read` gate holds (an employee without it gets 403, an
employee granted it gets 200, an anonymous caller 401).

Every period is September 2026 so the default "month-start → today"
window never decides a result.
"""
from datetime import date, datetime, time

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee

FROM = date(2026, 9, 1)
TO = date(2026, 9, 30)
IN = date(2026, 9, 10)
BEFORE = date(2026, 8, 15)
AFTER = date(2026, 10, 2)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _get(client, store_id, slug, headers, **extra):
    params = {"store_ids": str(store_id), "from": FROM.isoformat(),
              "to": TO.isoformat(), **extra}
    return client.get(f"/api/v2/reports/{slug}", headers=headers,
                      query_string=params)


def _ok(client, store_id, slug, **extra):
    resp = _get(client, store_id, slug, _h(login_admin(client, store_id)), **extra)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json()
    return body["rows"], body["totals"]


def _transfer(store_id, *, send_date=IN, amount=100.0, fee=5.0, tax=1.0,
              status="Sent", company="Intermex", customer_id=None,
              created_by=None):
    from api.Modules.Transfers.Models import Transfer
    with db_session():
        db.session.add(Transfer(
            store_id=store_id, created_by=created_by, send_date=send_date,
            company=company, service_type="Money Transfer",
            sender_name="Ana", send_amount=amount, fee=fee,
            federal_tax=tax, commission=0.0, status=status,
            customer_id=customer_id,
        ))
        db.session.commit()


def _customer(store_id, phone):
    from api.Modules.Customers.Models import Customer
    with db_session():
        c = Customer(store_id=store_id, full_name=f"C {phone}",
                     phone_country="US", phone_number=phone)
        db.session.add(c)
        db.session.commit()
        return c.id


def _account(store_id, last4):
    from api.Modules.BankSync.Models import StripeBankAccount
    with db_session():
        a = StripeBankAccount(store_id=store_id, last4=last4,
                              stripe_account_id=f"fca_route_{last4}")
        db.session.add(a)
        db.session.commit()
        return a.id


_TXN = [0]


def _txn(store_id, account_id, *, cents, posted=IN, slug="", rule_id=None):
    from api.Modules.BankSync.Models import BankTransaction
    _TXN[0] += 1
    with db_session():
        db.session.add(BankTransaction(
            store_id=store_id, stripe_bank_account_id=account_id,
            stripe_transaction_id=f"txn_route_{_TXN[0]}",
            amount_cents=cents, status="posted",
            posted_at=datetime.combine(posted, time(12, 0)),
            category_slug=slug, matched_rule_id=rule_id,
        ))
        db.session.commit()


# ── gate ─────────────────────────────────────────────────


def _employee(client, store_id, username, matrix):
    from api.Core.Permissions import set_user_permissions
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, role="employee",
                 is_active=True)
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()
        uid = u.id
    set_user_permissions(store_id, uid, matrix)
    return _h(login_employee(client, store_id, username, "emppass1234"))


SLUGS = [
    "new-vs-returning", "fees-vs-tax", "cancelled-transfers", "ach-volume",
    "returned-check-status", "bank-transactions-breakdown", "daily-drops",
    "check-deposits", "bank-rule-audit", "bank-charges-by-account",
    "period-comparison", "employee-activity",
]


@pytest.mark.parametrize("slug", SLUGS)
def test_an_employee_without_reports_read_is_refused(client, test_store_id, slug):
    _transfer(test_store_id)
    h = _employee(client, test_store_id, f"rr_no_{slug[:10]}",
                  {"transfers": {"read": True}})
    resp = _get(client, test_store_id, slug, h)
    assert resp.status_code == 403
    assert "totals" not in resp.get_data(as_text=True)


@pytest.mark.parametrize("slug", SLUGS)
def test_an_employee_granted_reports_read_may_read(client, test_store_id, slug):
    h = _employee(client, test_store_id, f"rr_ok_{slug[:10]}",
                  {"reports": {"read": True}})
    resp = _get(client, test_store_id, slug, h)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert {"rows", "totals"} <= set(resp.get_json())


@pytest.mark.parametrize("slug", SLUGS)
def test_anonymous_is_401(client, test_store_id, slug):
    assert _get(client, test_store_id, slug, {}).status_code == 401


# ── numbers ──────────────────────────────────────────────


def test_fees_vs_tax(client, test_store_id):
    _transfer(test_store_id, fee=6.0, tax=2.0)
    _transfer(test_store_id, fee=4.0, tax=1.0)
    _transfer(test_store_id, fee=50.0, tax=50.0, status="Canceled")
    _transfer(test_store_id, fee=70.0, tax=70.0, send_date=AFTER)
    rows, totals = _ok(client, test_store_id, "fees-vs-tax")
    assert [(r["label"], r["amount"]) for r in rows] == [
        ("Fees (store revenue)", pytest.approx(10.0)),
        ("Federal Tax (pass-through)", pytest.approx(3.0)),
    ]
    assert totals["count"] == 2
    assert totals["fees"] == pytest.approx(10.0)
    assert totals["tax"] == pytest.approx(3.0)
    assert totals["ratio"] == pytest.approx(0.3)


def test_new_vs_returning(client, test_store_id):
    old = _customer(test_store_id, "5550000001")
    new = _customer(test_store_id, "5550000002")
    _transfer(test_store_id, customer_id=old, send_date=BEFORE, amount=999.0)
    _transfer(test_store_id, customer_id=old, amount=100.0)
    _transfer(test_store_id, customer_id=old, amount=50.0)
    _transfer(test_store_id, customer_id=new, amount=200.0)
    _transfer(test_store_id, customer_id=None, amount=30.0)
    rows, totals = _ok(client, test_store_id, "new-vs-returning")
    by = {r["bucket"]: r for r in rows}
    assert by["New senders"]["customers"] == 1
    assert by["New senders"]["sent"] == pytest.approx(200.0)
    assert by["Returning senders"]["customers"] == 1
    assert by["Returning senders"]["txns"] == 2
    assert by["Returning senders"]["sent"] == pytest.approx(150.0)
    assert by["Walk-in (unidentified)"]["sent"] == pytest.approx(30.0)
    assert totals == {"customers": 3, "txns": 4, "sent": pytest.approx(380.0),
                      "new_count": 1, "returning_count": 1}


def test_new_vs_returning_hides_the_walk_in_row_when_there_are_none(
        client, test_store_id):
    _transfer(test_store_id, customer_id=_customer(test_store_id, "5550000003"))
    rows, _ = _ok(client, test_store_id, "new-vs-returning")
    assert [r["bucket"] for r in rows] == ["New senders", "Returning senders"]


def test_cancelled_transfers(client, test_store_id):
    _transfer(test_store_id, amount=100.0, status="Canceled")
    _transfer(test_store_id, amount=40.0, status="Rejected")
    _transfer(test_store_id, amount=500.0)  # live — never listed
    _transfer(test_store_id, amount=70.0, status="Canceled", send_date=BEFORE)
    rows, totals = _ok(client, test_store_id, "cancelled-transfers")
    assert sorted(r["status"] for r in rows) == ["Canceled", "Rejected"]
    assert totals["count"] == 2
    assert totals["amount"] == pytest.approx(140.0)
    assert totals["canceled"] == 1
    assert totals["rejected"] == 1


def test_ach_volume(client, test_store_id):
    from api.Modules.Batches.Models import ACHBatch
    with db_session():
        for i, (company, amt, d) in enumerate([
            ("Intermex", 300.0, IN), ("Intermex", 200.0, IN),
            ("Maxi", 900.0, IN), ("Maxi", 5000.0, AFTER),
        ]):
            db.session.add(ACHBatch(store_id=test_store_id, ach_date=d,
                                    company=company, ach_amount=amt,
                                    batch_ref=f"ROUTE-{i}"))
        db.session.commit()
    rows, totals = _ok(client, test_store_id, "ach-volume")
    assert [(r["company"], r["count"], r["amount"]) for r in rows] == [
        ("Maxi", 1, pytest.approx(900.0)),
        ("Intermex", 2, pytest.approx(500.0)),
    ]
    assert totals == {"count": 3, "amount": pytest.approx(1400.0)}


def test_returned_check_status(client, test_store_id):
    from api.Modules.ReturnChecks.Models import ReturnCheck, ReturnCheckPayment
    with db_session():
        pending = ReturnCheck(store_id=test_store_id, bounced_on=IN,
                              customer_name="P", amount=300.0, status="pending")
        loss = ReturnCheck(store_id=test_store_id, bounced_on=IN,
                           customer_name="L", amount=200.0, status="loss")
        outside = ReturnCheck(store_id=test_store_id, bounced_on=BEFORE,
                              customer_name="O", amount=999.0, status="pending")
        db.session.add_all([pending, loss, outside])
        db.session.flush()
        db.session.add_all([
            ReturnCheckPayment(return_check_id=pending.id, amount=100.0, paid_on=IN),
            ReturnCheckPayment(return_check_id=loss.id, amount=50.0, paid_on=IN),
        ])
        db.session.commit()
    rows, totals = _ok(client, test_store_id, "returned-check-status")
    assert [(r["status_key"], r["count"], r["amount"], r["recovered"]) for r in rows] == [
        ("pending", 1, pytest.approx(300.0), pytest.approx(100.0)),
        ("loss", 1, pytest.approx(200.0), pytest.approx(50.0)),
    ]
    assert totals["count"] == 2
    assert totals["amount"] == pytest.approx(500.0)
    assert totals["recovered"] == pytest.approx(150.0)
    assert totals["loss_fraud"] == pytest.approx(150.0)  # 200 written off − 50 paid back
    # Paybacks within the face amount are not a gain: only the 150
    # write-off moves the net.
    assert totals["fees"] == pytest.approx(0.0)
    assert totals["net_gl"] == pytest.approx(-150.0)


def test_bank_transactions_breakdown(client, test_store_id):
    acct = _account(test_store_id, "1111")
    _txn(test_store_id, acct, cents=50000, slug="drop")
    _txn(test_store_id, acct, cents=-1200, slug="bank_charge")
    _txn(test_store_id, acct, cents=-800, slug="bank_charge")
    _txn(test_store_id, acct, cents=-3000)
    _txn(test_store_id, acct, cents=99999, posted=AFTER)
    rows, totals = _ok(client, test_store_id, "bank-transactions-breakdown")
    assert [(r["slug"], r["count"], r["signed"]) for r in rows] == [
        ("drop", 1, pytest.approx(500.0)),
        ("", 1, pytest.approx(-30.0)),
        ("bank_charge", 2, pytest.approx(-20.0)),
    ]
    assert totals["count"] == 4
    assert totals["amount"] == pytest.approx(550.0)
    assert totals["inflow"] == pytest.approx(500.0)
    assert totals["outflow"] == pytest.approx(-50.0)


def _line_item(store_id, kind, report_date, amount):
    from api.Modules.DailyBook.Models import DailyLineItem
    with db_session():
        db.session.add(DailyLineItem(store_id=store_id, report_date=report_date,
                                     kind=kind, at_time=time(9, 0), amount=amount))
        db.session.commit()


@pytest.mark.parametrize("slug,kind,other_kind", [
    ("daily-drops", "drop", "check_deposit"),
    ("check-deposits", "check_deposit", "drop"),
])
def test_daily_line_item_reports(client, test_store_id, slug, kind, other_kind):
    _line_item(test_store_id, kind, date(2026, 9, 3), 100.0)
    _line_item(test_store_id, kind, date(2026, 9, 3), 50.0)
    _line_item(test_store_id, kind, date(2026, 9, 9), 30.0)
    _line_item(test_store_id, kind, AFTER, 999.0)
    _line_item(test_store_id, other_kind, date(2026, 9, 3), 777.0)
    rows, totals = _ok(client, test_store_id, slug)
    assert [(r["date"], r["count"], r["amount"]) for r in rows] == [
        ("2026-09-09", 1, pytest.approx(30.0)),
        ("2026-09-03", 2, pytest.approx(150.0)),
    ]
    assert totals["count"] == 3
    assert totals["amount"] == pytest.approx(180.0)
    assert totals["avg_per_day"] == pytest.approx(90.0)


def test_bank_rule_audit(client, test_store_id):
    from api.Modules.BankSync.Models import BankRule
    acct = _account(test_store_id, "2222")
    with db_session():
        rule = BankRule(store_id=test_store_id, enabled=True,
                        target_kind="bank_charge", desc_match_type="contains",
                        desc_match_value="FEE", description="fees")
        db.session.add(rule)
        db.session.commit()
        rid = rule.id
    _txn(test_store_id, acct, cents=-500, slug="bank_charge", rule_id=rid)
    _txn(test_store_id, acct, cents=-700, slug="bank_charge", rule_id=rid)
    _txn(test_store_id, acct, cents=-900, slug="bank_charge")  # hand-tagged
    _txn(test_store_id, acct, cents=-100, slug="bank_charge", rule_id=rid,
         posted=AFTER)
    rows, totals = _ok(client, test_store_id, "bank-rule-audit")
    assert len(rows) == 1
    assert rows[0]["rule_id"] == rid
    assert rows[0]["label"] == f"Rule #{rid}"
    assert rows[0]["match"] == 'contains: "FEE"'
    assert rows[0]["count"] == 2
    assert rows[0]["amount"] == pytest.approx(12.0)
    assert totals == {"count": 2, "amount": pytest.approx(12.0), "rules": 1}


def test_bank_charges_by_account(client, test_store_id):
    a = _account(test_store_id, "3333")
    b = _account(test_store_id, "4444")
    _txn(test_store_id, a, cents=-1000, slug="bank_charge")
    _txn(test_store_id, a, cents=-500, slug="bank_charge_3333")
    _txn(test_store_id, b, cents=-4000, slug="bank_charge_4444")
    _txn(test_store_id, b, cents=-9000, slug="")  # not a charge
    _txn(test_store_id, a, cents=-7700, slug="bank_charge", posted=AFTER)
    rows, totals = _ok(client, test_store_id, "bank-charges-by-account")
    assert [(r["last4"], r["count"], r["amount"], r["avg"]) for r in rows] == [
        ("4444", 1, pytest.approx(40.0), pytest.approx(40.0)),
        ("3333", 2, pytest.approx(15.0), pytest.approx(7.5)),
    ]
    assert totals == {"count": 3, "amount": pytest.approx(55.0)}


def _by_label(rows):
    return {r["label"]: r for r in rows}


def test_period_comparison_against_the_prior_period(client, test_store_id):
    from api.Modules.DailyBook.Models import DailyReport
    _transfer(test_store_id, amount=300.0, fee=10.0, tax=3.0)
    _transfer(test_store_id, amount=100.0, fee=5.0, tax=1.0, send_date=BEFORE)
    with db_session():
        db.session.add(DailyReport(store_id=test_store_id, report_date=IN,
                                   taxable_sales=90.0, cash_expense=40.0))
        db.session.commit()
    rows, totals = _ok(client, test_store_id, "period-comparison")
    by = _by_label(rows)
    assert len(rows) == 7
    assert by["Transfers"]["current"] == 1 and by["Transfers"]["prior"] == 1
    assert by["Total Sent"]["current"] == pytest.approx(300.0)
    assert by["Total Sent"]["prior"] == pytest.approx(100.0)
    assert by["Total Sent"]["delta"] == pytest.approx(200.0)
    assert by["Total Sent"]["pct"] == pytest.approx(200.0)
    assert by["Fees Earned"]["current"] == pytest.approx(10.0)
    assert by["Federal Tax"]["prior"] == pytest.approx(1.0)
    assert by["Total Income"]["current"] == pytest.approx(100.0)  # 90 sales + 10 fees
    assert by["Total Expenses"]["current"] == pytest.approx(40.0)
    assert by["Net Income"]["current"] == pytest.approx(60.0)
    assert by["Net Income"]["prior"] == pytest.approx(5.0)
    assert totals["prior_label"] == "Aug 02 – Aug 31, 2026"


def test_period_comparison_against_a_custom_window(client, test_store_id):
    _transfer(test_store_id, amount=300.0)
    _transfer(test_store_id, amount=80.0, send_date=date(2025, 9, 10))
    rows, totals = _ok(client, test_store_id, "period-comparison",
                       compare_from="2025-09-30", compare_to="2025-09-01")
    by = _by_label(rows)
    assert by["Total Sent"]["prior"] == pytest.approx(80.0)
    assert totals["prior_label"] == "Sep 01 – Sep 30, 2025"


def test_employee_activity(client, test_store_id, test_admin_id):
    _transfer(test_store_id, amount=100.0, created_by=test_admin_id,
              send_date=date(2026, 9, 4))
    _transfer(test_store_id, amount=60.0, created_by=test_admin_id,
              send_date=date(2026, 9, 12))
    _transfer(test_store_id, amount=500.0, created_by=test_admin_id,
              status="Canceled")
    _transfer(test_store_id, amount=20.0, created_by=None)
    _transfer(test_store_id, amount=999.0, created_by=test_admin_id,
              send_date=AFTER)
    rows, totals = _ok(client, test_store_id, "employee-activity")
    assert len(rows) == 2
    admin_row, walk = rows
    assert admin_row["count"] == 2
    assert admin_row["sent"] == pytest.approx(160.0)
    assert admin_row["cancels"] == 1
    assert admin_row["last_activity"] == "2026-09-12"
    assert admin_row["username"]
    assert walk["employee"] == "(unattributed)"
    assert walk["count"] == 1
    assert totals == {"count": 3, "sent": pytest.approx(180.0), "cancels": 1}
