"""The payroll (time-clock), audit-log and customer CSV exports build
their files with ``api.Core.Csv.build_csv`` instead of a hand-rolled
``csv.writer`` + ``StringIO``. The bytes must not change: these files
are opened in spreadsheets and payroll tools that key on them.

Each test pins the exact body, including the CRLF line endings
``csv.writer`` emits and the quoting of commas and quotes.
"""
import csv
import io
from datetime import date, datetime

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _legacy_csv(headers, rows):
    """What the controllers wrote by hand before ``build_csv``."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(headers)
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


# ── time clock ──────────────────────────────────────────────


def test_timeclock_csv_bytes(client, test_store_id):
    from api.Modules.Tenancy.Models import StoreEmployee
    from api.Modules.TimeClock.Models import TimeClockEntry
    with db_session():
        emp = StoreEmployee(
            store_id=test_store_id, name='Maria "Mia", Lopez',
            is_active=True,
        )
        db.session.add(emp); db.session.commit()
        db.session.add(TimeClockEntry(
            store_id=test_store_id, store_employee_id=emp.id,
            clock_in_at=datetime(2026, 5, 18, 9, 0),
            clock_out_at=datetime(2026, 5, 18, 17, 0),
            hours_worked=8.0, notes="Opening,\nthen inventory",
            status="approved",
        ))
        db.session.commit()
    resp = client.get(
        "/api/v2/admin/timeclock.csv?from=2026-05-18&to=2026-05-19",
        headers=_h(login_admin(client, test_store_id)),
    )
    assert resp.status_code == 200, resp.text
    assert resp.text == (
        "Employee,Clock in (UTC),Clock out (UTC),Hours worked,Status,"
        "Adjusted,Break minutes,Late minutes,Notes\r\n"
        '"Maria ""Mia"", Lopez",2026-05-18T09:00:00,2026-05-18T17:00:00,'
        '8.00,approved,no,0,,"Opening, then inventory"\r\n'
    )


def test_timeclock_csv_empty_window_is_header_only(client, test_store_id):
    resp = client.get(
        "/api/v2/admin/timeclock.csv?from=2020-01-01&to=2020-01-02",
        headers=_h(login_admin(client, test_store_id)),
    )
    assert resp.status_code == 200
    assert resp.text == (
        "Employee,Clock in (UTC),Clock out (UTC),Hours worked,Status,"
        "Adjusted,Break minutes,Late minutes,Notes\r\n"
    )


def test_timeclock_csv_refused_for_cashier(client, test_store_id):
    _, token = make_employee_client(test_store_id, username_suffix="csvx")
    resp = client.get(
        "/api/v2/admin/timeclock.csv?from=2026-05-18&to=2026-05-19",
        headers=_h(token),
    )
    assert resp.status_code == 403


# ── audit log ───────────────────────────────────────────────


def test_audit_log_csv_bytes_match_the_json_feed(client, test_store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        db.session.add(OperatorAuditLog(
            store_id=test_store_id, action="update",
            target_type="batch", target_id="7",
            target_label='Batch "A", May', user_id=None,
            user_name="Tester", user_role="admin",
            summary="amount, date changed",
            created_at=datetime(2026, 5, 18, 9, 30),
        ))
        db.session.commit()
    h = _h(login_admin(client, test_store_id))
    feed = client.get("/api/v2/admin/audit-log", headers=h).json()["rows"]
    resp = client.get("/api/v2/admin/audit-log.csv", headers=h)
    assert resp.status_code == 200, resp.text
    keys = ("ts", "user_name", "user_role", "action", "target_type",
            "target_id", "target_label", "summary", "source")
    expected = _legacy_csv(
        ["Timestamp", "User", "Role", "Action", "Target type",
         "Target id", "Target label", "Summary", "Source"],
        [[r.get(k) or "" for k in keys] for r in feed],
    )
    assert resp.text == expected
    assert '"Batch ""A"", May"' in resp.text


# ── customers ───────────────────────────────────────────────


def test_customers_csv_bytes(client, test_store_id):
    from api.Modules.Customers.Models import Customer
    stamp = datetime(2026, 5, 1, 12, 0)
    with db_session():
        db.session.add(Customer(
            store_id=test_store_id, full_name="Lopez, Ana",
            phone_country="+52", phone_number="5512345678",
            dob=date(1990, 2, 3), address='12 "B" St',
            created_at=stamp, updated_at=stamp,
        ))
        db.session.commit()
    resp = client.get(
        "/api/v2/customers/export.csv",
        headers=_h(login_admin(client, test_store_id)),
    )
    assert resp.status_code == 200, resp.text
    assert resp.text == (
        "Full name,Phone country,Phone number,DOB,Address,Home store,"
        "Created,Last updated\r\n"
        '"Lopez, Ana",+52,5512345678,1990-02-03,"12 ""B"" St",'
        "(this store),2026-05-01T12:00:00,2026-05-01T12:00:00\r\n"
    )


def test_customers_csv_refused_without_a_store_scope(client):
    """A token with no store (superadmin) has no directory to dump."""
    from tests.conftest import login_superadmin
    resp = client.get(
        "/api/v2/customers/export.csv", headers=_h(login_superadmin(client)),
    )
    assert resp.status_code == 403
