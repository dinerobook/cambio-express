"""POST /transfers must save a transfer exactly once.

Live report (2026-10-13): an employee at a live store saved a money
transfer, got a 500, pressed Save again about 8 times and every press
logged another copy. Two causes, each pinned here:

1. The rate limiter crashed AFTER the route committed. slowapi with
   ``headers_enabled=True`` tried to stamp X-RateLimit-* onto the
   route's return value, which is a Pydantic model, and raised. The
   transfer had been saved; the caller saw a 500. The suite runs with
   the limiter off, so nothing caught it. The tests below turn the
   limiter on in-process.
2. Nothing stopped a resubmit from writing again. The form now sends
   one ``Idempotency-Key`` per form, and a repeat save with that key
   returns the transfer it already created.

Plus a third failure found on the way: a store could save only ONE
sender without a phone. The next one hit the customer table's unique
(store, phone country, phone) constraint and the save 500ed.
"""
from __future__ import annotations

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _roster(store_id: int, name: str = "Cash One") -> int:
    from api.Modules.Tenancy.Models import StoreEmployee
    with db_session():
        e = StoreEmployee(store_id=store_id, name=name, is_active=True)
        db.session.add(e)
        db.session.commit()
        return e.id


def _employee_login(client, store_id: int, username: str, matrix) -> dict:
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


def _body(emp_id: int, **over) -> dict:
    body = {
        "send_date": "2026-10-12",
        "company": "Intermex",
        "service_type": "Money Transfer",
        "sender_name": "Juan Perez",
        "send_amount": 200.0,
        "fee": 5.0,
        "recipient_name": "Maria Perez",
        "country": "Mexico",
        "employee_id": emp_id,
    }
    body.update(over)
    return body


def _post(client, headers, body, key: str | None = None):
    h = dict(headers)
    if key is not None:
        h["Idempotency-Key"] = key
    return client.post("/api/v2/transfers", headers=h, json=body)


def _count(model, **filters) -> int:
    with db_session():
        return db.session.query(model).filter_by(**filters).count()


@pytest.fixture
def limiter_on():
    """Run the request with the rate limiter armed, as in production.
    slowapi reads ``enabled`` on every call, so flipping it here
    exercises the real wrapper; storage is reset so no bucket leaks
    into another test."""
    from api.Core.RateLimit import limiter
    limiter.reset()
    limiter.enabled = True
    try:
        yield limiter
    finally:
        limiter.enabled = False
        limiter.reset()


@pytest.fixture
def cashier(client, test_store_id):
    """An employee login that may read + create transfers, and the
    roster row they pick as "Processed by"."""
    headers = _employee_login(
        client, test_store_id, "cashier_retry",
        {"transfers": {"read": True, "create": True}},
    )
    return headers, _roster(test_store_id)


# ── 1. The 500 after the commit ────────────────────────────────


def test_employee_create_with_limiter_on_returns_201_once(
    client, test_store_id, cashier, limiter_on,
):
    from api.Modules.Transfers.Models import Transfer
    headers, emp = cashier
    resp = _post(client, headers, _body(emp))
    assert resp.status_code == 201, resp.get_data(as_text=True)
    assert resp.get_json()["transfer"]["employee_name"] == "Cash One"
    assert _count(Transfer, store_id=test_store_id) == 1


def test_admin_create_with_limiter_on_returns_201(
    client, test_store_id, limiter_on,
):
    emp = _roster(test_store_id, "Admin Desk")
    headers = _h(login_admin(client, test_store_id))
    resp = _post(client, headers, _body(emp))
    assert resp.status_code == 201, resp.get_data(as_text=True)


def test_limiter_still_refuses_a_flood_with_429(
    client, test_store_id, cashier, limiter_on,
):
    """Turning the headers off must not turn the limit off."""
    headers, emp = cashier
    statuses = [
        _post(client, headers, _body(emp)).status_code for _ in range(31)
    ]
    assert statuses[:30] == [201] * 30
    assert statuses[30] == 429


# ── 2. Save once per form ──────────────────────────────────────


def test_same_key_twice_returns_the_first_transfer(
    client, test_store_id, cashier,
):
    from api.Modules.Audit.Models import TransferAudit
    from api.Modules.Customers.Models import Customer
    from api.Modules.Transfers.Models import Transfer
    headers, emp = cashier
    body = _body(emp, sender_phone="5551234567")
    first = _post(client, headers, body, key="form-1")
    again = _post(client, headers, body, key="form-1")
    assert first.status_code == 201
    assert again.status_code == 201
    tid = first.get_json()["transfer"]["id"]
    assert again.get_json()["transfer"]["id"] == tid
    assert _count(Transfer, store_id=test_store_id) == 1
    assert _count(TransferAudit, transfer_id=tid) == 1
    assert _count(Customer, store_id=test_store_id) == 1


def test_replay_returns_what_was_saved_not_the_new_body(
    client, test_store_id, cashier,
):
    """A repeat save is a retry of the first one: it never edits it.
    Changes go through Edit transfer, which is audited as an edit."""
    headers, emp = cashier
    first = _post(client, headers, _body(emp, send_amount=200.0), key="k")
    again = _post(client, headers, _body(emp, send_amount=999.0), key="k")
    assert again.get_json()["transfer"]["id"] == first.get_json()["transfer"]["id"]
    assert again.get_json()["transfer"]["send_amount"] == 200.0


def test_different_keys_save_two_transfers(client, test_store_id, cashier):
    from api.Modules.Transfers.Models import Transfer
    headers, emp = cashier
    assert _post(client, headers, _body(emp), key="a").status_code == 201
    assert _post(client, headers, _body(emp), key="b").status_code == 201
    assert _count(Transfer, store_id=test_store_id) == 2


def test_no_key_keeps_the_old_behaviour(client, test_store_id, cashier):
    """Callers that send no key (scripts, older SPA builds still open
    in a tab) save every request, exactly as before."""
    from api.Modules.Transfers.Models import Transfer
    headers, emp = cashier
    assert _post(client, headers, _body(emp)).status_code == 201
    assert _post(client, headers, _body(emp)).status_code == 201
    assert _count(Transfer, store_id=test_store_id) == 2
    with db_session():
        keys = {t.client_request_id for t in db.session.query(Transfer)}
    assert keys == {None}


def test_blank_key_is_treated_as_no_key(client, test_store_id, cashier):
    from api.Modules.Transfers.Models import Transfer
    headers, emp = cashier
    assert _post(client, headers, _body(emp), key="  ").status_code == 201
    assert _post(client, headers, _body(emp), key="  ").status_code == 201
    assert _count(Transfer, store_id=test_store_id) == 2


def test_key_longer_than_64_is_refused(client, test_store_id, cashier):
    from api.Modules.Transfers.Models import Transfer
    headers, emp = cashier
    resp = _post(client, headers, _body(emp), key="x" * 65)
    assert resp.status_code == 422
    assert _count(Transfer, store_id=test_store_id) == 0


def test_key_stays_inside_its_store(test_store_id, test_admin_id):
    """Store B reusing store A's key saves its own transfer and never
    sees store A's."""
    from datetime import date
    from api.Modules.Tenancy.Models import Store, StoreEmployee
    from api.Modules.Transfers.Services import (
        CreateTransferInput, create_transfer,
    )
    emp_a = _roster(test_store_id, "A desk")
    with db_session():
        s2 = Store(name="Other", slug="other-tx-idem", email="o@x.com",
                   plan="trial")
        db.session.add(s2)
        db.session.commit()
        e2 = StoreEmployee(store_id=s2.id, name="B desk", is_active=True)
        db.session.add(e2)
        db.session.commit()

        def _input(store_id, emp_id):
            return CreateTransferInput(
                store_id=store_id, created_by_user_id=test_admin_id,
                send_date=date(2026, 10, 12), company="Intermex",
                service_type="Money Transfer", sender_name="S",
                send_amount=10.0, employee_id=emp_id,
                client_request_id="shared-key",
            )

        a = create_transfer(db.session, _input(test_store_id, emp_a))
        b = create_transfer(db.session, _input(s2.id, e2.id))
        db.session.commit()
        assert a.id != b.id
        assert (a.store_id, b.store_id) == (test_store_id, s2.id)


def test_racing_saves_answer_the_loser_with_the_winner(
    client, test_store_id, cashier, monkeypatch,
):
    """Two saves of one form both miss the replay lookup (they ran at
    the same moment). The unique index lets one INSERT through; the
    other must get that transfer back, not a 500 and not a copy."""
    from api.Modules.Transfers.Models import Transfer
    from api.Modules.Transfers.Services import transfers as svc
    headers, emp = cashier
    first = _post(client, headers, _body(emp), key="race")
    assert first.status_code == 201
    # The service's own lookup now misses, as it would for the
    # request that lost the race.
    monkeypatch.setattr(svc, "find_replayed_transfer", lambda *a, **k: None)
    loser = _post(client, headers, _body(emp), key="race")
    assert loser.status_code == 201, loser.get_data(as_text=True)
    assert loser.get_json()["transfer"]["id"] == first.get_json()["transfer"]["id"]
    assert _count(Transfer, store_id=test_store_id) == 1


# ── Permissions: the key never widens access ───────────────────


def test_employee_without_create_is_refused_with_or_without_key(
    client, test_store_id,
):
    from api.Modules.Transfers.Models import Transfer
    emp = _roster(test_store_id)
    reader = _employee_login(
        client, test_store_id, "reader_retry", {"transfers": {"read": True}},
    )
    assert _post(client, reader, _body(emp)).status_code == 403
    assert _post(client, reader, _body(emp), key="r").status_code == 403
    assert _count(Transfer, store_id=test_store_id) == 0


def test_replay_of_a_saved_key_still_needs_create(
    client, test_store_id, cashier,
):
    """A login that lost ``transfers.create`` cannot read a saved
    transfer back by replaying its key."""
    headers, emp = cashier
    assert _post(client, headers, _body(emp), key="locked").status_code == 201
    reader = _employee_login(
        client, test_store_id, "reader_replay", {"transfers": {"read": True}},
    )
    assert _post(client, reader, _body(emp), key="locked").status_code == 403


def test_create_without_login_is_401_with_key(client):
    resp = client.post(
        "/api/v2/transfers", headers={"Idempotency-Key": "anon"},
        json=_body(1),
    )
    assert resp.status_code == 401


def test_unknown_employee_is_422_and_frees_the_key(
    client, test_store_id, cashier,
):
    """A refused save stores nothing, so the corrected form can save
    with the same key."""
    headers, emp = cashier
    bad = _post(client, headers, _body(999999), key="fix-me")
    assert bad.status_code == 422
    good = _post(client, headers, _body(emp), key="fix-me")
    assert good.status_code == 201


# ── 3. Senders without a phone ─────────────────────────────────


def test_two_senders_without_a_phone_both_save(client, test_store_id, cashier):
    from api.Modules.Customers.Models import Customer
    headers, emp = cashier
    a = _post(client, headers, _body(emp, sender_name="Ana", sender_phone=""))
    b = _post(client, headers, _body(emp, sender_name="Beto", sender_phone=""))
    assert a.status_code == 201, a.get_data(as_text=True)
    assert b.status_code == 201, b.get_data(as_text=True)
    ja, jb = a.get_json()["transfer"], b.get_json()["transfer"]
    assert ja["customer_id"] != jb["customer_id"]
    assert ja["sender_phone"] == jb["sender_phone"] == ""
    with db_session():
        names = {
            c.full_name: c.phone_number
            for c in db.session.query(Customer).filter_by(store_id=test_store_id)
        }
    assert names == {"Ana": None, "Beto": None}


def test_phoneless_customer_reads_back_as_empty_phone(
    client, test_store_id, cashier,
):
    """NULL in the table, "" on every page that shows it."""
    headers, emp = cashier
    cid = _post(
        client, headers, _body(emp, sender_name="Ana", sender_phone=""),
    ).get_json()["transfer"]["customer_id"]
    admin = _h(login_admin(client, test_store_id))
    one = client.get(
        f"/api/v2/customers/{cid}?store_id={test_store_id}", headers=admin,
    )
    assert one.status_code == 200, one.get_data(as_text=True)
    assert one.get_json()["customer"]["phone_number"] == ""
    found = client.get(
        f"/api/v2/customers/search?store_id={test_store_id}&q=Ana",
        headers=admin,
    )
    assert found.status_code == 200, found.get_data(as_text=True)
    row = next(r for r in found.get_json()["matches"] if r["id"] == cid)
    assert row["phone_number"] == ""


def test_store_with_an_old_blank_phone_row_saves_new_phoneless_senders(
    client, test_store_id, cashier,
):
    """Stores that already hold a customer saved with phone "" (before
    this fix) keep working: the new row is NULL and does not collide."""
    from api.Modules.Customers.Models import Customer
    with db_session():
        db.session.add(Customer(
            store_id=test_store_id, full_name="Legacy", phone_country="+1",
            phone_number="",
        ))
        db.session.commit()
    headers, emp = cashier
    resp = _post(client, headers, _body(emp, sender_name="New", sender_phone=""))
    assert resp.status_code == 201, resp.get_data(as_text=True)


def test_repeat_sender_with_a_phone_still_reuses_one_customer(
    client, test_store_id, cashier,
):
    headers, emp = cashier
    a = _post(client, headers, _body(emp, sender_phone="5550001111"))
    b = _post(client, headers, _body(emp, sender_phone="5550001111"))
    assert a.get_json()["transfer"]["customer_id"] == b.get_json()["transfer"]["customer_id"]
