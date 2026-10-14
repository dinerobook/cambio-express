"""Regression tests for the time-clock fixes of the Oct-13 sweep.

  - Self-punch routes (clock-out, break start / stop) ride the same
    ``time_clock.create`` right as clock-in, so a default employee
    can finish the shift they started.
  - Admin edits keep the break deducted from ``hours_worked``.
  - Payroll list / CSV / paystub windows are the store's local days.
  - Roster-passkey enrollment changes write an audit row.
  - ``_parse_iso`` normalises offsets to UTC, not the server zone.
"""
from datetime import datetime
from types import SimpleNamespace

from tests._app import db, db_session
from tests.Modules.TimeClock.test_timeclock_endpoint import (
    _login,
    _seed_employee,
    _seed_passkey,
)


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _employee_token(client, store_id):
    from tests.conftest import make_employee_client
    _, jwt = make_employee_client(store_id, username_suffix="punch")
    return jwt


def _set_store_tz(store_id, tz):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        db.session.get(Store, store_id).timezone = tz
        db.session.commit()


def _seed_entry(store_id, emp_id, clock_in, clock_out, *,
                break_minutes=0.0, hours=None, status="pending"):
    from api.Modules.TimeClock.Models import TimeClockEntry
    with db_session():
        e = TimeClockEntry(
            store_id=store_id, store_employee_id=emp_id,
            clock_in_at=clock_in, clock_out_at=clock_out,
            hours_worked=hours, break_minutes=break_minutes,
            status=status,
        )
        db.session.add(e); db.session.commit()
        return e.id


# ── Self-punch permission ───────────────────────────────────


def test_default_employee_can_run_a_whole_shift(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Self Punch")
    h = _auth(_employee_token(client, test_store_id))
    body = {"store_employee_id": emp_id, "notes": ""}
    r = client.post("/api/v2/timeclock/clock-in", json=body, headers=h)
    assert r.status_code == 201, r.get_data(as_text=True)
    r = client.post("/api/v2/timeclock/break/start",
                    json={"store_employee_id": emp_id}, headers=h)
    assert r.status_code == 200, r.get_data(as_text=True)
    assert r.get_json()["entry"]["break_started_at"] is not None
    r = client.post("/api/v2/timeclock/break/stop",
                    json={"store_employee_id": emp_id}, headers=h)
    assert r.status_code == 200, r.get_data(as_text=True)
    assert r.get_json()["entry"]["break_started_at"] is None
    r = client.post("/api/v2/timeclock/clock-out", json=body, headers=h)
    assert r.status_code == 200, r.get_data(as_text=True)
    assert r.get_json()["entry"]["clock_out_at"] is not None


def test_self_punch_routes_refuse_without_time_clock_create(
    client, test_store_id,
):
    from api.Core.Permissions import (
        get_permission_matrix, set_store_permissions,
    )
    from api.Modules.TimeClock.Models import TimeClockEntry
    with db_session():
        emp_id = _seed_employee(test_store_id, name="No Create")
    # Open a shift as the admin, then revoke the employee's create.
    admin_h = _auth(_login(client, test_store_id))
    assert client.post(
        "/api/v2/timeclock/clock-in",
        json={"store_employee_id": emp_id, "notes": ""}, headers=admin_h,
    ).status_code == 201
    cur = get_permission_matrix(
        test_store_id, ["employee"], ["employee"],
    )["matrix"]["employee"]
    cur["time_clock"] = {
        "read": True, "create": False, "update": False, "delete": False,
    }
    set_store_permissions(test_store_id, "employee", cur)
    h = _auth(_employee_token(client, test_store_id))
    for path in ("/api/v2/timeclock/break/start",
                 "/api/v2/timeclock/break/stop",
                 "/api/v2/timeclock/clock-out"):
        body = {"store_employee_id": emp_id}
        if path.endswith("clock-out"):
            body["notes"] = ""
        r = client.post(path, json=body, headers=h)
        assert r.status_code == 403, (path, r.get_data(as_text=True))
    with db_session():
        e = db.session.query(TimeClockEntry).filter_by(
            store_employee_id=emp_id).one()
        assert e.clock_out_at is None
        assert e.break_started_at is None


def test_self_punch_cannot_close_another_stores_shift(
    client, test_store_id,
):
    """The punch is scoped to the caller's store: a roster id from
    another store is 404 and its open shift is untouched."""
    from api.Modules.Tenancy.Models import Store, StoreEmployee
    from api.Modules.TimeClock.Models import TimeClockEntry
    with db_session():
        other = Store(name="Other", slug="other-sp", email="o@x.com",
                      plan="basic")
        db.session.add(other); db.session.commit()
        e = StoreEmployee(store_id=other.id, name="Elsewhere",
                          is_active=True)
        db.session.add(e); db.session.commit()
        other_emp, other_id = e.id, other.id
    entry_id = _seed_entry(other_id, other_emp,
                           datetime(2026, 5, 18, 9), None)
    h = _auth(_employee_token(client, test_store_id))
    for path in ("/api/v2/timeclock/break/start",
                 "/api/v2/timeclock/clock-out"):
        body = {"store_employee_id": other_emp}
        if path.endswith("clock-out"):
            body["notes"] = ""
        r = client.post(path, json=body, headers=h)
        assert r.status_code == 404, path
    with db_session():
        e = db.session.get(TimeClockEntry, entry_id)
        assert e.clock_out_at is None and e.break_started_at is None


# ── Break kept on admin edits ───────────────────────────────


def test_approve_keeps_break_deducted_and_does_not_mark_adjusted(
    client, test_store_id,
):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Lunch")
    entry_id = _seed_entry(
        test_store_id, emp_id,
        datetime(2026, 5, 18, 9), datetime(2026, 5, 18, 17),
        break_minutes=60.0, hours=7.0,
    )
    r = client.put(
        f"/api/v2/admin/timeclock/{entry_id}", json={"status": "approved"},
        headers=_auth(_login(client, test_store_id)),
    )
    assert r.status_code == 200, r.get_data(as_text=True)
    row = r.get_json()["entry"]
    assert row["hours_worked"] == 7.0
    assert row["status"] == "approved"
    # A pure status change is still an adjustment, but the hours
    # must not have moved (the bug re-added the 60-min break).
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        summary = db.session.query(OperatorAuditLog).filter_by(
            target_type="time_clock_entry", target_id=str(entry_id),
            action="admin_update",
        ).one().summary
    assert "hours_worked" not in summary


def test_editing_times_still_subtracts_break(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Edit Lunch")
    entry_id = _seed_entry(
        test_store_id, emp_id,
        datetime(2026, 5, 18, 9), datetime(2026, 5, 18, 17),
        break_minutes=30.0, hours=7.5,
    )
    r = client.put(
        f"/api/v2/admin/timeclock/{entry_id}",
        json={"clock_out_at": "2026-05-18T18:00:00"},
        headers=_auth(_login(client, test_store_id)),
    )
    assert r.status_code == 200, r.get_data(as_text=True)
    assert r.get_json()["entry"]["hours_worked"] == 8.5


def test_compute_hours_never_negative():
    from api.Modules.TimeClock.Services import _compute_hours
    assert _compute_hours(
        datetime(2026, 5, 18, 9), datetime(2026, 5, 18, 9, 30), 90.0,
    ) == 0.0
    assert _compute_hours(datetime(2026, 5, 18, 9), None, 60.0) is None


# ── Store-local payroll windows ─────────────────────────────


def _evening_shift_on_period_end(test_store_id):
    """Chicago store, 20:00–23:00 local on May 14 (the last day of a
    May 1–14 period) == 01:00–04:00 UTC on May 15."""
    _set_store_tz(test_store_id, "America/Chicago")
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Night Owl")
    entry_id = _seed_entry(
        test_store_id, emp_id,
        datetime(2026, 5, 15, 1), datetime(2026, 5, 15, 4),
        hours=3.0, status="approved",
    )
    return emp_id, entry_id


def test_payroll_list_uses_store_local_days(client, test_store_id):
    emp_id, entry_id = _evening_shift_on_period_end(test_store_id)
    h = _auth(_login(client, test_store_id))
    r = client.get("/api/v2/admin/timeclock?from=2026-05-01&to=2026-05-15",
                   headers=h)
    assert r.status_code == 200
    assert [row["id"] for row in r.get_json()["rows"]] == [entry_id]
    assert r.get_json()["approved_hours"] == 3.0
    # …and it is NOT also counted in the next period.
    r = client.get("/api/v2/admin/timeclock?from=2026-05-15&to=2026-05-29",
                   headers=h)
    assert r.get_json()["rows"] == []


def test_payroll_csv_uses_store_local_days(client, test_store_id):
    _evening_shift_on_period_end(test_store_id)
    r = client.get(
        "/api/v2/admin/timeclock.csv?from=2026-05-01&to=2026-05-15",
        headers=_auth(_login(client, test_store_id)),
    )
    assert r.status_code == 200
    assert "Night Owl" in r.get_data(as_text=True)


def test_paystub_uses_store_local_days(client, test_store_id):
    emp_id, _ = _evening_shift_on_period_end(test_store_id)
    r = client.get(
        f"/api/v2/admin/timeclock/paystub/{emp_id}"
        "?from=2026-05-01&to=2026-05-15",
        headers=_auth(_login(client, test_store_id)),
    )
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    assert body["approved_hours"] == 3.0
    assert (body["from_date"], body["to_date"]) == ("2026-05-01", "2026-05-15")


def test_paystub_dates_stay_the_requested_days_east_of_utc(
    client, test_store_id,
):
    """Manila's May 1 starts at 16:00 UTC on Apr 30 — the stub is still
    labelled with the days the admin asked for."""
    _set_store_tz(test_store_id, "Asia/Manila")
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Manila")
    r = client.get(
        f"/api/v2/admin/timeclock/paystub/{emp_id}"
        "?from=2026-05-01&to=2026-05-15",
        headers=_auth(_login(client, test_store_id)),
    )
    body = r.get_json()
    assert (body["from_date"], body["to_date"]) == ("2026-05-01", "2026-05-15")


def test_store_without_timezone_keeps_utc_days(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="UTC")
    entry_id = _seed_entry(
        test_store_id, emp_id,
        datetime(2026, 5, 15, 1), datetime(2026, 5, 15, 4), hours=3.0,
    )
    r = client.get("/api/v2/admin/timeclock?from=2026-05-15&to=2026-05-16",
                   headers=_auth(_login(client, test_store_id)))
    assert [row["id"] for row in r.get_json()["rows"]] == [entry_id]


# ── Passkey enrollment audit ────────────────────────────────


def _passkey_audits(store_id, emp_id, action):
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        return [
            (r.summary, r.user_role) for r in
            db.session.query(OperatorAuditLog).filter_by(
                store_id=store_id, target_type="time_clock_passkey",
                target_id=str(emp_id), action=action,
            ).all()
        ]


def test_passkey_register_finish_writes_audit_row(
    client, test_store_id, monkeypatch,
):
    import webauthn
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Enroll Audit")
    token = _login(client, test_store_id)
    reg_token = client.post(
        f"/api/v2/admin/timeclock/credentials/{emp_id}/register/begin",
        headers=_auth(token),
    ).get_json()["register_token"]
    monkeypatch.setattr(
        webauthn, "verify_registration_response",
        lambda **kw: SimpleNamespace(
            credential_id=b"cred", credential_public_key=b"pub",
            sign_count=0, aaguid="",
        ),
    )
    r = client.post(
        f"/api/v2/admin/timeclock/credentials/{emp_id}/register/finish",
        json={"register_token": reg_token, "credential": {"id": "x"},
              "name": "Front phone"},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.get_data(as_text=True)
    rows = _passkey_audits(test_store_id, emp_id, "passkey_register")
    assert len(rows) == 1
    assert "Enroll Audit" in rows[0][0] and "Front phone" in rows[0][0]
    assert rows[0][1] == "admin"


def test_passkey_register_failure_writes_no_audit_row(
    client, test_store_id,
):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Bad Token")
    r = client.post(
        f"/api/v2/admin/timeclock/credentials/{emp_id}/register/finish",
        json={"register_token": "garbage", "credential": {"id": "x"}},
        headers=_auth(_login(client, test_store_id)),
    )
    assert r.status_code == 401
    assert _passkey_audits(test_store_id, emp_id, "passkey_register") == []


def test_passkey_delete_writes_audit_row(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Remove Audit")
    _seed_passkey(test_store_id, emp_id, name="Old tablet")
    h = _auth(_login(client, test_store_id))
    r = client.delete(f"/api/v2/admin/timeclock/credentials/{emp_id}",
                      headers=h)
    assert r.status_code == 204
    rows = _passkey_audits(test_store_id, emp_id, "passkey_delete")
    assert len(rows) == 1 and "Old tablet" in rows[0][0]
    # Nothing left to remove → 404 and no second audit row.
    r = client.delete(f"/api/v2/admin/timeclock/credentials/{emp_id}",
                      headers=h)
    assert r.status_code == 404
    assert len(_passkey_audits(test_store_id, emp_id, "passkey_delete")) == 1


# ── _parse_iso ──────────────────────────────────────────────


def test_parse_iso_converts_offsets_to_utc():
    import os
    import time
    from api.Modules.TimeClock.Controllers import _parse_iso
    # Put the process in a non-UTC zone so a server-local conversion
    # would show up.
    saved = os.environ.get("TZ")
    os.environ["TZ"] = "America/Chicago"
    time.tzset()
    try:
        assert _parse_iso("2026-05-18T09:00:00-05:00", "x") == datetime(
            2026, 5, 18, 14, 0)
        assert _parse_iso("2026-05-18T14:00:00Z", "x") == datetime(
            2026, 5, 18, 14, 0)
        assert _parse_iso("2026-05-18T14:00:00", "x") == datetime(
            2026, 5, 18, 14, 0)
    finally:
        if saved is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = saved
        time.tzset()
