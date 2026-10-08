"""Edge-path HTTP tests for the TimeClock controllers.

Covers the branches the main ``test_timeclock_endpoint.py`` suite
leaves out: CSV window cap, break cross-tenant / not-clocked-in
errors, admin-edit validation (ISO parsing, null fields, role gate),
the passkey assertion gate past token decoding, and the admin
passkey enrollment ceremony (begin / finish).

Helpers are shared with ``test_timeclock_endpoint.py``.
"""
import json
from datetime import datetime
from types import SimpleNamespace

from tests._app import db, db_session
from tests.Modules.TimeClock.test_timeclock_endpoint import (
    _employee_login,
    _enable_passkey_gate,
    _login,
    _seed_employee,
    _seed_other_store,
    _seed_passkey,
)


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _backfill_entry(client, headers, emp_id):
    return client.post(
        "/api/v2/admin/timeclock",
        json={
            "store_employee_id": emp_id,
            "clock_in_at": "2026-05-18T09:00:00",
            "clock_out_at": "2026-05-18T17:00:00",
        },
        headers=headers,
    ).get_json()["entry"]["id"]


# ── CSV window ──────────────────────────────────────────────


def test_admin_timeclock_csv_rejects_window_over_370_days(
    client, test_store_id,
):
    resp = client.get(
        "/api/v2/admin/timeclock.csv?from=2024-01-01&to=2026-05-01",
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 422
    assert "370" in resp.get_data(as_text=True)


# ── Break edges ─────────────────────────────────────────────


def test_break_start_404s_for_cross_tenant_employee(client, test_store_id):
    with db_session():
        other_emp = _seed_employee(_seed_other_store(), name="Foreign Break")
    resp = client.post(
        "/api/v2/timeclock/break/start",
        json={"store_employee_id": other_emp},
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 404


def test_break_stop_404s_for_cross_tenant_employee(client, test_store_id):
    with db_session():
        other_emp = _seed_employee(_seed_other_store(), name="Foreign Stop")
    resp = client.post(
        "/api/v2/timeclock/break/stop",
        json={"store_employee_id": other_emp},
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 404


def test_break_stop_409s_when_not_clocked_in(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="No Shift Stop")
    resp = client.post(
        "/api/v2/timeclock/break/stop",
        json={"store_employee_id": emp_id},
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 409
    assert "not currently clocked in" in resp.get_data(as_text=True).lower()


# ── Admin create / update / delete validation ───────────────


def test_admin_update_accepts_utc_z_suffix(client, test_store_id):
    """The SPA sends ``...Z`` timestamps; the server must parse
    them and recompute hours."""
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Zulu")
    headers = _auth(_login(client, test_store_id))
    entry_id = _backfill_entry(client, headers, emp_id)
    resp = client.put(
        f"/api/v2/admin/timeclock/{entry_id}",
        json={"clock_out_at": "2026-05-18T11:00:00Z"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.get_json()["entry"]["hours_worked"] is not None


def test_admin_create_rejects_malformed_timestamp(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Bad Date")
    resp = client.post(
        "/api/v2/admin/timeclock",
        json={"store_employee_id": emp_id, "clock_in_at": "yesterday-ish"},
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 422
    assert "clock_in_at" in resp.get_data(as_text=True)


def test_admin_create_rejects_blank_clock_in(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Blank In")
    resp = client.post(
        "/api/v2/admin/timeclock",
        json={"store_employee_id": emp_id, "clock_in_at": "   "},
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 422
    assert "required" in resp.get_data(as_text=True).lower()


def test_admin_update_rejects_null_clock_in(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Null In")
    headers = _auth(_login(client, test_store_id))
    entry_id = _backfill_entry(client, headers, emp_id)
    resp = client.put(
        f"/api/v2/admin/timeclock/{entry_id}",
        json={"clock_in_at": None}, headers=headers,
    )
    assert resp.status_code == 422
    assert "clock_in_at" in resp.get_data(as_text=True)


def test_admin_update_rejects_null_status(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Null Status")
    headers = _auth(_login(client, test_store_id))
    entry_id = _backfill_entry(client, headers, emp_id)
    resp = client.put(
        f"/api/v2/admin/timeclock/{entry_id}",
        json={"status": None}, headers=headers,
    )
    assert resp.status_code == 422
    assert "status" in resp.get_data(as_text=True)


def test_admin_update_rejects_employee_role(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Locked Edit")
    entry_id = _backfill_entry(
        client, _auth(_login(client, test_store_id)), emp_id,
    )
    resp = client.put(
        f"/api/v2/admin/timeclock/{entry_id}",
        json={"notes": "mine now"},
        headers=_auth(_employee_login(client, test_store_id)),
    )
    assert resp.status_code == 403


def test_admin_delete_404s_for_cross_tenant_entry(client, test_store_id):
    """Another store's entry id 404s and the row survives."""
    from api.Modules.TimeClock.Models import TimeClockEntry
    with db_session():
        other_store = _seed_other_store()
        other_emp = _seed_employee(other_store, name="Foreign Del")
        e = TimeClockEntry(
            store_id=other_store, store_employee_id=other_emp,
            clock_in_at=datetime(2026, 5, 18, 9, 0),
            clock_out_at=datetime(2026, 5, 18, 17, 0),
            hours_worked=8.0, status="pending",
        )
        db.session.add(e); db.session.commit()
        entry_id = e.id
    resp = client.delete(
        f"/api/v2/admin/timeclock/{entry_id}",
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 404
    with db_session():
        assert db.session.get(TimeClockEntry, entry_id) is not None


def test_user_id_from_claims_tolerates_missing_or_bad_sub():
    from api.Modules.TimeClock.Controllers import _user_id_from
    assert _user_id_from({}) is None
    assert _user_id_from({"sub": "not-a-number"}) is None
    assert _user_id_from({"sub": "42"}) == 42


# ── Passkey assertion verification (gate on) ────────────────


def _gate_punch(client, test_store_id, emp_id):
    from api.Modules.TimeClock.Services.passkey import issue_assert_token
    assert_token = issue_assert_token(
        store_id=test_store_id, store_employee_id=emp_id,
        challenge_b64="dGVzdA",
    )
    return client.post(
        "/api/v2/timeclock/clock-in",
        json={
            "store_employee_id": emp_id, "notes": "",
            "assert_token": assert_token, "assertion": {"id": "x"},
        },
        headers=_auth(_login(client, test_store_id)),
    )


def test_clock_in_blocked_when_assertion_does_not_verify(
    client, test_store_id,
):
    """A well-formed token with a garbage authenticator response is
    rejected by the real WebAuthn verifier, and no shift opens."""
    from api.Modules.TimeClock.Models import TimeClockEntry
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Forged")
    _enable_passkey_gate(test_store_id)
    _seed_passkey(test_store_id, emp_id)
    resp = _gate_punch(client, test_store_id, emp_id)
    assert resp.status_code == 401
    assert "did not verify" in resp.get_data(as_text=True).lower()
    with db_session():
        assert db.session.query(TimeClockEntry).filter_by(
            store_employee_id=emp_id).count() == 0


def test_clock_in_passes_gate_and_bumps_sign_count(
    client, test_store_id, monkeypatch,
):
    """A verified assertion opens the shift and records the new sign
    count + last-used time on the passkey. The WebAuthn crypto is
    stubbed (it needs a real authenticator); the rest is real."""
    import webauthn
    from api.Modules.TimeClock.Models import StoreEmployeePasskey
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Verified")
    _enable_passkey_gate(test_store_id)
    pk_id = _seed_passkey(test_store_id, emp_id)
    monkeypatch.setattr(
        webauthn, "verify_authentication_response",
        lambda **kw: SimpleNamespace(new_sign_count=7),
    )
    resp = _gate_punch(client, test_store_id, emp_id)
    assert resp.status_code == 201, resp.get_data(as_text=True)
    with db_session():
        pk = db.session.get(StoreEmployeePasskey, pk_id)
        assert pk.sign_count == 7
        assert pk.last_used_at is not None


def test_clock_in_blocked_when_sign_count_goes_backwards(
    client, test_store_id, monkeypatch,
):
    """Cloned-authenticator protection: a lower sign count is refused."""
    import webauthn
    from api.Modules.TimeClock.Models import StoreEmployeePasskey
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Cloned")
    _enable_passkey_gate(test_store_id)
    pk_id = _seed_passkey(test_store_id, emp_id)
    with db_session():
        db.session.get(StoreEmployeePasskey, pk_id).sign_count = 10
        db.session.commit()
    monkeypatch.setattr(
        webauthn, "verify_authentication_response",
        lambda **kw: SimpleNamespace(new_sign_count=3),
    )
    resp = _gate_punch(client, test_store_id, emp_id)
    assert resp.status_code == 401
    assert "clone" in resp.get_data(as_text=True).lower()
    with db_session():
        assert db.session.get(StoreEmployeePasskey, pk_id).sign_count == 10


def test_clock_in_gate_on_but_passkey_deleted_is_422_not_500(
    client, test_store_id,
):
    """Valid token but the roster member's passkey was removed after
    the challenge was issued. Regression: this used to surface as a
    500 because the typed error was never mapped."""
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Removed PK")
    _enable_passkey_gate(test_store_id)
    resp = _gate_punch(client, test_store_id, emp_id)
    assert resp.status_code == 422, resp.get_data(as_text=True)
    assert "passkey" in resp.get_data(as_text=True).lower()


def test_paystub_rejects_window_over_370_days(client, test_store_id):
    with db_session():
        emp = _seed_employee(test_store_id, name="Long Stub")
    resp = client.get(
        f"/api/v2/admin/timeclock/paystub/{emp}"
        "?from=2024-01-01&to=2026-05-01",
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 422
    assert "370" in resp.get_data(as_text=True)


# ── Admin passkey enrollment (register begin / finish) ──────


def _register_begin(client, test_store_id, emp_id):
    token = _login(client, test_store_id)
    body = client.post(
        f"/api/v2/admin/timeclock/credentials/{emp_id}/register/begin",
        headers=_auth(token),
    ).get_json()
    return token, body["register_token"]


def test_register_begin_returns_options_and_bound_token(
    client, test_store_id,
):
    from api.Modules.TimeClock.Services.passkey import decode_register_token
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Enroll Me")
    resp = client.post(
        f"/api/v2/admin/timeclock/credentials/{emp_id}/register/begin",
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json()
    assert body["options_json"]
    claims = decode_register_token(body["register_token"])
    assert claims["store_id"] == test_store_id
    assert claims["store_employee_id"] == emp_id


def test_register_begin_excludes_existing_credential(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Re-enroll")
    _seed_passkey(test_store_id, emp_id)
    resp = client.post(
        f"/api/v2/admin/timeclock/credentials/{emp_id}/register/begin",
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 200
    options = json.loads(resp.get_json()["options_json"])
    assert len(options["excludeCredentials"]) == 1


def test_register_begin_404s_cross_tenant_and_403s_employee(
    client, test_store_id,
):
    with db_session():
        other_emp = _seed_employee(_seed_other_store(), name="Foreign Enroll")
        own_emp = _seed_employee(test_store_id, name="Own Enroll")
    resp = client.post(
        f"/api/v2/admin/timeclock/credentials/{other_emp}/register/begin",
        headers=_auth(_login(client, test_store_id)),
    )
    assert resp.status_code == 404
    resp = client.post(
        f"/api/v2/admin/timeclock/credentials/{own_emp}/register/begin",
        headers=_auth(_employee_login(client, test_store_id)),
    )
    assert resp.status_code == 403


def test_register_finish_validation_errors(client, test_store_id):
    from api.Modules.TimeClock.Services.passkey import issue_register_token
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Finish Bad")
        other_emp = _seed_employee(test_store_id, name="Finish Other")
        foreign = _seed_employee(_seed_other_store(), name="Finish Foreign")
    token, reg_token = _register_begin(client, test_store_id, emp_id)
    headers = _auth(token)
    url = f"/api/v2/admin/timeclock/credentials/{emp_id}/register/finish"

    # Missing fields -> 400.
    assert client.post(url, json={}, headers=headers).status_code == 400
    # Garbage token -> 401.
    resp = client.post(
        url, json={"register_token": "nope", "credential": {"id": "x"}},
        headers=headers,
    )
    assert resp.status_code == 401
    # Token minted for a different roster member -> 401.
    other_token = issue_register_token(
        store_id=test_store_id, store_employee_id=other_emp,
        challenge_b64="dGVzdA",
    )
    resp = client.post(
        url, json={"register_token": other_token, "credential": {"id": "x"}},
        headers=headers,
    )
    assert resp.status_code == 401
    assert "does not match" in resp.get_data(as_text=True).lower()
    # Valid token but a forged attestation -> 400.
    resp = client.post(
        url, json={"register_token": reg_token, "credential": {"id": "x"}},
        headers=headers,
    )
    assert resp.status_code == 400
    assert "did not verify" in resp.get_data(as_text=True).lower()
    # Cross-tenant roster id -> 404.
    resp = client.post(
        f"/api/v2/admin/timeclock/credentials/{foreign}/register/finish",
        json={"register_token": reg_token, "credential": {"id": "x"}},
        headers=headers,
    )
    assert resp.status_code == 404


def test_register_finish_requires_admin(client, test_store_id):
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Finish Perm")
    resp = client.post(
        f"/api/v2/admin/timeclock/credentials/{emp_id}/register/finish",
        json={"register_token": "x", "credential": {}},
        headers=_auth(_employee_login(client, test_store_id)),
    )
    assert resp.status_code == 403


def test_register_finish_replaces_existing_passkey(
    client, test_store_id, monkeypatch,
):
    """Re-enrolling swaps the single passkey row (v1 cap). The
    attestation crypto is stubbed; token, scoping and persistence
    are real."""
    import webauthn
    from api.Modules.TimeClock.Models import StoreEmployeePasskey
    with db_session():
        emp_id = _seed_employee(test_store_id, name="Swap PK")
    _seed_passkey(test_store_id, emp_id, name="Old phone")
    token, reg_token = _register_begin(client, test_store_id, emp_id)
    monkeypatch.setattr(
        webauthn, "verify_registration_response",
        lambda **kw: SimpleNamespace(
            credential_id=b"new-cred", credential_public_key=b"new-pub",
            sign_count=2, aaguid="abc",
        ),
    )
    resp = client.post(
        f"/api/v2/admin/timeclock/credentials/{emp_id}/register/finish",
        json={
            "register_token": reg_token, "credential": {"id": "x"},
            "name": "  New phone  ",
        },
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json()
    assert body["has_passkey"] is True
    assert body["name"] == "New phone"
    with db_session():
        rows = db.session.query(StoreEmployeePasskey).filter_by(
            store_employee_id=emp_id).all()
        assert len(rows) == 1
        assert rows[0].credential_id == b"new-cred"
        assert rows[0].sign_count == 2
