"""HTTP integration tests for the ReturnChecks Controllers."""
from datetime import date
from tests._app import db, db_session


def _login(client, store_id):
    resp = client.post(
        "/api/v2/auth/login",
        json={
            "username": "admin@test.com",
            "password": "testpass123!",
            "store_id": store_id,
        },
    )
    return resp.get_json()["access_token"]


def _seed_rc(store_id, *, customer_name="Bouncer Co",
              amount=500.0, bounced_on_=None, status="pending"):
    from api.Modules.ReturnChecks.Models import ReturnCheck
    from tests._app import db
    r = ReturnCheck(
        store_id=store_id,
        bounced_on=bounced_on_ or date.today(),
        customer_name=customer_name,
        check_number="123",
        payer_bank="Bank A",
        amount=amount,
        status=status,
    )
    db.session.add(r); db.session.commit()
    return r.id


# ── GET /return-checks ──────────────────────────────────────


def test_list_returns_envelope(client, test_store_id):
    token = _login(client, test_store_id)
    resp = client.get(
        "/api/v2/return-checks",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert "rows" in resp.get_json()


def test_list_filters_by_status(client, test_store_id):
    with db_session():
        _seed_rc(test_store_id, customer_name="Pending Co", status="pending")
        rc_loss = _seed_rc(test_store_id, customer_name="Loss Co", status="loss")
        _ = rc_loss
    token = _login(client, test_store_id)
    resp = client.get(
        "/api/v2/return-checks?status=pending",
        headers={"Authorization": f"Bearer {token}"},
    )
    rows = resp.get_json()["rows"]
    statuses = {r["status"] for r in rows}
    assert statuses == {"pending"}


# ── POST /return-checks ─────────────────────────────────────


def test_create_round_trip(client, test_store_id):
    token = _login(client, test_store_id)
    resp = client.post(
        "/api/v2/return-checks",
        json={
            "bounced_on":    "2026-04-15",
            "customer_name": "Acme Corp",
            "company_name":  "Acme LLC",
            "check_number":  "12345",
            "payer_bank":    "Wells Fargo",
            "amount":        750.0,
            "return_check_fee": 25.0,
            "notes":         "second bounce",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201
    rc = resp.get_json()["return_check"]
    assert rc["customer_name"] == "Acme Corp"
    assert rc["company_name"] == "Acme LLC"
    assert rc["amount"] == 750.0
    assert rc["return_check_fee"] == 25.0
    assert rc["status"] == "pending"


def test_create_rejects_zero_amount(client, test_store_id):
    token = _login(client, test_store_id)
    resp = client.post(
        "/api/v2/return-checks",
        json={
            "bounced_on":    "2026-04-15",
            "customer_name": "Bad Amount",
            "amount":        0.0,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_create_requires_admin_role(client):
    """Cashier role can't create return checks."""
    from api.Modules.Tenancy.Models import User
    from tests._app import db
    with db_session():
        u = User(
            store_id=None, username="emp_rc_test",
            role="employee", is_active=True,
        )
        u.set_password("emppass1234")
        db.session.add(u); db.session.commit()
    try:
        login = client.post(
            "/api/v2/auth/login",
            json={
                "username": "emp_rc_test",
                "password": "emppass1234",
                "store_id": None,
            },
        )
        token = login.get_json()["access_token"]
        resp = client.post(
            "/api/v2/return-checks",
            json={
                "bounced_on":    "2026-04-15",
                "customer_name": "X",
                "company_name":  "X Co",
                "amount":        100.0,
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 403
    finally:
        with db_session():
            u2 = db.session.query(User).filter_by(
                username="emp_rc_test",
            ).first()
            if u2:
                db.session.delete(u2); db.session.commit()


# ── PUT /return-checks/{id} ─────────────────────────────────


def test_update_round_trip(client, test_store_id):
    with db_session():
        rid = _seed_rc(test_store_id, customer_name="Old Name")
    token = _login(client, test_store_id)
    resp = client.put(
        f"/api/v2/return-checks/{rid}",
        json={
            "bounced_on":    "2026-05-01",
            "customer_name": "New Name",
            "company_name":  "New Co",
            "check_number":  "99",
            "payer_bank":    "Bank B",
            "amount":        300.0,
            "notes":         "renamed",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    rc = resp.get_json()["return_check"]
    assert rc["customer_name"] == "New Name"
    assert rc["amount"] == 300.0


# ── Status transitions ──────────────────────────────────────


def test_mark_loss_round_trip(client, test_store_id):
    with db_session():
        rid = _seed_rc(test_store_id, status="pending")
    token = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/return-checks/{rid}/mark-loss",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    rc = resp.get_json()["return_check"]
    assert rc["status"] == "loss"
    assert rc["status_changed_on"] != ""


def test_mark_fraud_rejects_non_pending(client, test_store_id):
    with db_session():
        rid = _seed_rc(test_store_id, status="loss")
    token = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/return-checks/{rid}/mark-fraud",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 409


def test_reopen_round_trip(client, test_store_id):
    from api.Modules.ReturnChecks.Models import ReturnCheck
    from tests._app import db
    with db_session():
        rid = _seed_rc(test_store_id, status="loss")
        rc = db.session.get(ReturnCheck, rid)
        rc.status_changed_on = date.today()
        db.session.commit()
    token = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/return-checks/{rid}/reopen",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    rc = resp.get_json()["return_check"]
    assert rc["status"] == "pending"
    assert rc["status_changed_on"] == ""


def test_reopen_rejects_pending(client, test_store_id):
    with db_session():
        rid = _seed_rc(test_store_id, status="pending")
    token = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/return-checks/{rid}/reopen",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 409


def test_reopen_rejects_recovered(client, test_store_id):
    """A fully-paid (recovered) check can't be reopened — recovery is
    payment-driven, so the undo path is removing a payment, not
    reopening (which would strand it with no remaining balance)."""
    with db_session():
        rid = _seed_rc(test_store_id, status="recovered")
    token = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/return-checks/{rid}/reopen",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 409


# ── GET /return-checks/{id}/payments ────────────────────────


def test_payments_returns_envelope(client, test_store_id):
    with db_session():
        rid = _seed_rc(test_store_id)
    token = _login(client, test_store_id)
    resp = client.get(
        f"/api/v2/return-checks/{rid}/payments",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.get_json()["payments"] == []


def test_payments_404_when_missing(client, test_store_id):
    token = _login(client, test_store_id)
    resp = client.get(
        "/api/v2/return-checks/9999/payments",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404


# ── Auth ────────────────────────────────────────────────────


# ── POST /return-checks/{id}/payments ───────────────────────


def test_record_payment_creates_row_and_daily_line_item(
    client, test_store_id,
):
    """Recording a partial pay inserts a ReturnCheckPayment row and
    auto-creates the matching DailyLineItem(kind='return_payback')
    so the daily-book stays in sync without double-entry."""
    from api.Modules.DailyBook.Models import DailyLineItem
    with db_session():
        rid = _seed_rc(test_store_id, amount=500.0)
    token = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={
            "paid_on": "2026-04-15",
            "amount":  200.0,
            "method":  "cash",
            "note":    "first installment",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201
    body = resp.get_json()
    assert body["payment"]["amount"] == 200.0
    # Recovered total flows into the parent envelope so the SPA
    # can render the new "remaining" value without a refetch.
    assert body["return_check"]["recovered_total"] == 200.0
    assert body["return_check"]["status"] == "pending"  # still partial
    with db_session():
        items = (
            db.session.query(DailyLineItem)
              .filter_by(return_check_id=rid, kind="return_payback")
              .all()
        )
        assert len(items) == 1
        assert items[0].amount == 200.0


def test_record_payment_auto_flips_status_to_recovered(
    client, test_store_id,
):
    """When the running total meets the full amount, the check
    auto-flips pending → recovered with a status_changed_on stamp.
    Mirrors the legacy form behavior."""
    with db_session():
        rid = _seed_rc(test_store_id, amount=300.0)
    token = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-15", "amount": 300.0},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201
    rc = resp.get_json()["return_check"]
    assert rc["status"] == "recovered"
    assert rc["status_changed_on"] != ""


def test_record_payment_caps_at_remaining(client, test_store_id):
    """A second installment that would overshoot gets capped at the
    remaining balance — matches the legacy submit-time cap so the
    cashier can't accidentally accrue credit on a returned check."""
    with db_session():
        rid = _seed_rc(test_store_id, amount=100.0)
    token = _login(client, test_store_id)
    client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-15", "amount": 60.0},
        headers={"Authorization": f"Bearer {token}"},
    )
    resp = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-16", "amount": 999.0},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201
    assert resp.get_json()["payment"]["amount"] == 40.0  # capped


def test_return_check_fee_included_in_recoverable(client, test_store_id):
    """The returned-check fee raises the balance the customer owes:
    payments pay down to amount+fee, so paying the face amount alone
    leaves the check pending and a later installment caps at the
    remaining fee — not beyond it."""
    token = _login(client, test_store_id)
    auth = {"Authorization": f"Bearer {token}"}
    # $500 check + $25 fee → $525 owed in total.
    create = client.post(
        "/api/v2/return-checks",
        json={
            "bounced_on":       "2026-04-15",
            "customer_name":    "Fee Co",
            "company_name":     "Fee LLC",
            "amount":           500.0,
            "return_check_fee": 25.0,
        },
        headers=auth,
    )
    assert create.status_code == 201
    rid = create.get_json()["return_check"]["id"]

    # Paying the face amount alone still leaves the $25 fee owed —
    # the check stays pending, not recovered.
    p1 = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-16", "amount": 500.0},
        headers=auth,
    )
    assert p1.status_code == 201
    assert p1.get_json()["return_check"]["status"] == "pending"

    # A follow-up that would overshoot caps at the remaining $25 fee.
    p2 = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-17", "amount": 999.0},
        headers=auth,
    )
    assert p2.status_code == 201
    assert p2.get_json()["payment"]["amount"] == 25.0  # capped at fee
    rc = p2.get_json()["return_check"]
    assert rc["status"] == "recovered"           # fee paid → done
    assert rc["recovered_total"] == 525.0


def test_record_payment_rejects_on_closed_check(
    client, test_store_id,
):
    """Loss / fraud checks must be reopened before recording a
    payback — otherwise the daily book reflects payments against
    a written-off balance."""
    with db_session():
        rid = _seed_rc(test_store_id, status="loss")
    token = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-15", "amount": 50.0},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 409


def test_record_payment_404_when_check_missing(
    client, test_store_id,
):
    token = _login(client, test_store_id)
    resp = client.post(
        "/api/v2/return-checks/9999/payments",
        json={"paid_on": "2026-04-15", "amount": 10.0},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404


# ── DELETE /return-checks/{id}/payments/{pid} ───────────────


def test_delete_payment_removes_row_and_line_item(
    client, test_store_id,
):
    from api.Modules.DailyBook.Models import DailyLineItem
    with db_session():
        rid = _seed_rc(test_store_id, amount=400.0)
    token = _login(client, test_store_id)
    create = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-15", "amount": 100.0},
        headers={"Authorization": f"Bearer {token}"},
    )
    pid = create.get_json()["payment"]["id"]
    resp = client.delete(
        f"/api/v2/return-checks/{rid}/payments/{pid}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    rc = resp.get_json()["return_check"]
    assert rc["recovered_total"] == 0.0
    with db_session():
        items = (
            db.session.query(DailyLineItem)
              .filter_by(return_check_id=rid, kind="return_payback")
              .all()
        )
        assert items == []


def test_delete_payment_reverts_recovered_to_pending(
    client, test_store_id,
):
    """If deleting the final installment drops payments below the
    full amount, the auto-recovered status reverts to pending."""
    with db_session():
        rid = _seed_rc(test_store_id, amount=200.0)
    token = _login(client, test_store_id)
    create = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-15", "amount": 200.0},
        headers={"Authorization": f"Bearer {token}"},
    )
    pid = create.get_json()["payment"]["id"]
    # Sanity: full payment auto-recovered.
    assert create.get_json()["return_check"]["status"] == "recovered"
    resp = client.delete(
        f"/api/v2/return-checks/{rid}/payments/{pid}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    rc = resp.get_json()["return_check"]
    assert rc["status"] == "pending"
    assert rc["status_changed_on"] == ""


def test_delete_payment_404_when_payment_missing(
    client, test_store_id,
):
    with db_session():
        rid = _seed_rc(test_store_id)
    token = _login(client, test_store_id)
    resp = client.delete(
        f"/api/v2/return-checks/{rid}/payments/9999",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404


# ── Auth ────────────────────────────────────────────────────


def test_endpoints_require_jwt(client):
    g = client.get("/api/v2/return-checks")
    p = client.post("/api/v2/return-checks", json={
        "bounced_on": "2026-01-01",
        "customer_name": "X",
        "amount": 1.0,
    })
    u = client.put("/api/v2/return-checks/1", json={
        "bounced_on": "2026-01-01",
        "customer_name": "X",
        "amount": 1.0,
    })
    ml = client.post("/api/v2/return-checks/1/mark-loss")
    mf = client.post("/api/v2/return-checks/1/mark-fraud")
    ro = client.post("/api/v2/return-checks/1/reopen")
    pa = client.get("/api/v2/return-checks/1/payments")
    pp = client.post(
        "/api/v2/return-checks/1/payments",
        json={"paid_on": "2026-04-15", "amount": 10.0},
    )
    pd = client.delete("/api/v2/return-checks/1/payments/1")
    for r in (g, p, u, ml, mf, ro, pa, pp, pd):
        assert r.status_code == 401


def test_list_rejects_superadmin(client):
    from tests.conftest import login_superadmin
    token = login_superadmin(client)
    resp = client.get(
        "/api/v2/return-checks",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


# ── Status dates are the store's calendar day ──────────────────


def test_status_change_is_dated_on_the_stores_day(
    client, test_store_id, monkeypatch,
):
    """Marked a loss at 9:30pm in Chicago (02:30 UTC the next day):
    the check is dated that evening's day, not the server's UTC
    tomorrow."""
    from datetime import datetime, timezone

    import api.Core.Clock as clock
    from api.Modules.Tenancy.Models import Store

    class _LateEvening(datetime):
        @classmethod
        def now(cls, tz=None):  # type: ignore[override]
            fixed = datetime(2026, 10, 10, 2, 30, tzinfo=timezone.utc)
            return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)

    with db_session():
        db.session.get(Store, test_store_id).timezone = "America/Chicago"
        db.session.commit()
        rid = _seed_rc(test_store_id, status="pending",
                       bounced_on_=date(2026, 10, 1))
    token = _login(client, test_store_id)
    monkeypatch.setattr(clock, "datetime", _LateEvening)
    resp = client.post(
        f"/api/v2/return-checks/{rid}/mark-loss",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.get_json()["return_check"]["status_changed_on"] == "2026-10-09"


# ── Locked daily book ───────────────────────────────────────
#
# A payment mirrors a line on the daily book of the day it was paid.
# A locked day is view only (DailyBook/INVARIANTS.md "Lock rules"), so
# a payment can't land on it or leave it until it is unlocked.


def _lock_day(store_id, d, locked=True):
    from api.Modules.DailyBook.Services import lock_report, unlock_report
    with db_session():
        if locked:
            lock_report(db.session, store_id, d)
        else:
            unlock_report(db.session, store_id, d)
        db.session.commit()


def _paybacks(rid):
    from api.Modules.DailyBook.Models import DailyLineItem
    with db_session():
        return [
            float(i.amount) for i in db.session.query(DailyLineItem)
              .filter_by(return_check_id=rid, kind="return_payback").all()
        ]


def test_record_payment_on_a_locked_day_is_409(client, test_store_id):
    with db_session():
        rid = _seed_rc(test_store_id, amount=400.0)
    _lock_day(test_store_id, date(2026, 4, 15))
    headers = {"Authorization": f"Bearer {_login(client, test_store_id)}"}
    resp = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-15", "amount": 100.0}, headers=headers,
    )
    assert resp.status_code == 409
    assert "locked" in resp.get_json()["detail"]
    assert _paybacks(rid) == []
    # Another (unlocked) day still takes it.
    resp = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-16", "amount": 100.0}, headers=headers,
    )
    assert resp.status_code == 201
    assert _paybacks(rid) == [100.0]


def test_delete_payment_on_a_locked_day_is_409_until_unlocked(
    client, test_store_id,
):
    with db_session():
        rid = _seed_rc(test_store_id, amount=400.0)
    headers = {"Authorization": f"Bearer {_login(client, test_store_id)}"}
    pid = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "2026-04-15", "amount": 100.0}, headers=headers,
    ).get_json()["payment"]["id"]
    _lock_day(test_store_id, date(2026, 4, 15))
    url = f"/api/v2/return-checks/{rid}/payments/{pid}"
    resp = client.delete(url, headers=headers)
    assert resp.status_code == 409
    assert _paybacks(rid) == [100.0]
    _lock_day(test_store_id, date(2026, 4, 15), locked=False)
    assert client.delete(url, headers=headers).status_code == 200
    assert _paybacks(rid) == []


# ── Editing the amount re-checks recovery ───────────────────


def _edit_amount(client, token, rid, amount):
    return client.put(
        f"/api/v2/return-checks/{rid}",
        json={
            "bounced_on": "2026-09-01", "customer_name": "C",
            "company_name": "X", "amount": amount,
        },
        headers={"Authorization": f"Bearer {token}"},
    )


def _pay(client, token, rid, amount, paid_on="2026-09-02"):
    return client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": paid_on, "amount": amount},
        headers={"Authorization": f"Bearer {token}"},
    )


def test_lowering_amount_below_paid_recovers_the_check(
    client, test_store_id,
):
    """$60 paid on a $100 check, then the amount is corrected to $50:
    the check is now fully paid and must read recovered (it used to
    stay pending forever, with every further payback 409ing)."""
    with db_session():
        rid = _seed_rc(test_store_id, amount=100.0)
    token = _login(client, test_store_id)
    assert _pay(client, token, rid, 60.0).status_code == 201
    resp = _edit_amount(client, token, rid, 50.0)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    rc = resp.get_json()["return_check"]
    assert rc["status"] == "recovered"
    assert rc["status_changed_on"] != ""


def test_raising_a_recovered_amount_reopens_it_to_pending(
    client, test_store_id,
):
    """A recovered $100 check corrected to $150 has $50 left to
    collect: it goes back to pending and takes the next payback."""
    with db_session():
        rid = _seed_rc(test_store_id, amount=100.0)
    token = _login(client, test_store_id)
    assert _pay(client, token, rid, 100.0).get_json()[
        "return_check"]["status"] == "recovered"
    resp = _edit_amount(client, token, rid, 150.0)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    rc = resp.get_json()["return_check"]
    assert rc["status"] == "pending"
    assert rc["status_changed_on"] in ("", None)
    pay = _pay(client, token, rid, 50.0, paid_on="2026-09-03")
    assert pay.status_code == 201, pay.get_data(as_text=True)
    assert pay.get_json()["return_check"]["status"] == "recovered"


def test_editing_amount_leaves_written_off_checks_alone(
    client, test_store_id,
):
    """Loss / fraud are explicit write-offs — an edit never moves
    them, whatever the amount."""
    with db_session():
        loss = _seed_rc(test_store_id, amount=100.0, status="loss")
        fraud = _seed_rc(test_store_id, amount=100.0, status="fraud")
    token = _login(client, test_store_id)
    for rid, status in ((loss, "loss"), (fraud, "fraud")):
        resp = _edit_amount(client, token, rid, 10.0)
        assert resp.status_code == 200
        assert resp.get_json()["return_check"]["status"] == status


def test_editing_pending_amount_above_paid_stays_pending(
    client, test_store_id,
):
    with db_session():
        rid = _seed_rc(test_store_id, amount=100.0)
    token = _login(client, test_store_id)
    assert _pay(client, token, rid, 30.0).status_code == 201
    resp = _edit_amount(client, token, rid, 80.0)
    assert resp.get_json()["return_check"]["status"] == "pending"


# ── paging + sort ───────────────────────────────────────────


def _list(client, token, qs=""):
    resp = client.get(
        f"/api/v2/return-checks{qs}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()


def test_list_without_page_returns_every_check(client, test_store_id):
    from datetime import timedelta
    with db_session():
        for i in range(55):
            _seed_rc(test_store_id, customer_name=f"C{i:02d}",
                     bounced_on_=date(2026, 1, 1) + timedelta(days=i))
    token = _login(client, test_store_id)
    body = _list(client, token)
    assert len(body["rows"]) == 55
    assert body["total"] == 55
    # Newest bounce first, as before.
    assert body["rows"][0]["customer_name"] == "C54"


def test_list_pages_and_sorts_on_the_server(client, test_store_id):
    with db_session():
        for name, amt in [("Ana", 300.0), ("Bea", 100.0), ("Cy", 200.0)]:
            _seed_rc(test_store_id, customer_name=name, amount=amt)
    token = _login(client, test_store_id)
    body = _list(client, token, "?page=2&per_page=2&sort=amount&dir=asc")
    assert [r["customer_name"] for r in body["rows"]] == ["Ana"]
    assert (body["total"], body["page"], body["total_pages"]) == (3, 2, 2)
    by_name = _list(client, token, "?page=1&sort=customer&dir=desc")
    assert [r["customer_name"] for r in by_name["rows"]] == ["Cy", "Bea", "Ana"]


def test_list_page_respects_status_filter(client, test_store_id):
    with db_session():
        _seed_rc(test_store_id, customer_name="Open", status="pending")
        _seed_rc(test_store_id, customer_name="Done", status="recovered")
    token = _login(client, test_store_id)
    body = _list(client, token, "?status=recovered&page=1")
    assert [r["customer_name"] for r in body["rows"]] == ["Done"]
    assert body["total"] == 1


def test_list_rejects_bad_paging_and_direction(client, test_store_id):
    token = _login(client, test_store_id)
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/v2/return-checks?page=0", headers=h).status_code == 422
    assert client.get("/api/v2/return-checks?page=1&per_page=500", headers=h).status_code == 422
    assert client.get("/api/v2/return-checks?dir=up", headers=h).status_code == 422
