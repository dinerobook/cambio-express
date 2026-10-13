"""Debit card and payout credits on ACH batches.

A debit card send is invoiced like any send on the batch it is linked
to (send + federal tax), and the company credits what the customer
paid on the card (send + fee + tax) on its NEXT invoice: that
company's next batch by ACH date. So a batch expects
``transfers_total - card_credit`` and its variance is measured
against that. A payout (cash the store paid out for the company) is
never invoiced and is credited the same way, at the amount paid out.
See api/Modules/Batches/Services/batches.py and Transfers INVARIANTS
"Debit card sends" / "Payouts".
"""
from datetime import date

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def admin(client, test_store_id):
    return _h(login_admin(client, test_store_id))


def _batch(store_id, ref, day, *, company="Intermex", ach_amount=0.0):
    from api.Modules.Batches.Models import ACHBatch
    with db_session():
        b = ACHBatch(store_id=store_id, ach_date=day, company=company,
                     batch_ref=ref, ach_amount=ach_amount)
        db.session.add(b)
        db.session.commit()
        return b.id


def _send(store_id, ref, *, amount, fee=0.0, tax=0.0, card=False,
          status="Sent", service="Money Transfer", company="Intermex"):
    from api.Modules.Transfers.Models import Transfer
    with db_session():
        t = Transfer(
            store_id=store_id, send_date=date(2026, 3, 2), company=company,
            service_type=service, sender_name="S", send_amount=amount,
            fee=fee, federal_tax=tax, batch_id=ref, status=status,
            payment_method="debit_card" if card else None,
        )
        db.session.add(t)
        db.session.commit()


def _rows(client, admin):
    resp = client.get("/api/v2/batches", headers=admin)
    assert resp.status_code == 200, resp.text
    return {r["batch_ref"]: r for r in resp.json()["rows"]}


def test_card_send_is_owed_here_and_credited_on_the_next_batch(
    client, test_store_id, admin,
):
    _batch(test_store_id, "B1", date(2026, 3, 3), ach_amount=303.0)
    _batch(test_store_id, "B2", date(2026, 3, 4), ach_amount=197.0)
    _send(test_store_id, "B1", amount=100, fee=5, tax=1, card=True)
    _send(test_store_id, "B1", amount=200, fee=8, tax=2)
    _send(test_store_id, "B2", amount=300, fee=9, tax=3)

    rows = _rows(client, admin)
    b1, b2 = rows["B1"], rows["B2"]
    # B1: both sends invoiced, nothing credited yet.
    assert b1["transfers_total"] == 303.0
    assert b1["card_credit"] == 0.0
    assert b1["expected_ach"] == 303.0
    assert b1["variance"] == 0.0
    # What the customer paid by card (send + fee + tax) rides to B2.
    assert b1["card_credit_next"] == 106.0
    assert b1["card_credit_next_to"] == "B2"
    # B2: its own send, less B1's card credit.
    assert b2["transfers_total"] == 303.0
    assert b2["card_credit"] == 106.0
    assert b2["card_credit_from"] == "B1"
    assert b2["expected_ach"] == 197.0
    assert b2["variance"] == 0.0


def test_credit_is_pending_until_the_company_has_a_next_batch(
    client, test_store_id, admin,
):
    _batch(test_store_id, "P1", date(2026, 3, 3), ach_amount=101.0)
    _send(test_store_id, "P1", amount=100, fee=5, tax=1, card=True)
    row = _rows(client, admin)["P1"]
    assert row["card_credit_next"] == 106.0
    assert row["card_credit_next_to"] == ""
    assert row["variance"] == 0.0


def test_next_batch_is_by_ach_date_and_company(client, test_store_id, admin):
    """Entered out of order, and with another company's batch in
    between: the credit still lands on the same company's next ACH."""
    _batch(test_store_id, "LATE", date(2026, 3, 10))
    _batch(test_store_id, "MAXI", date(2026, 3, 5), company="Maxi")
    _batch(test_store_id, "EARLY", date(2026, 3, 1))
    _send(test_store_id, "EARLY", amount=50, fee=2, tax=0.5, card=True)

    rows = _rows(client, admin)
    assert rows["EARLY"]["card_credit_next_to"] == "LATE"
    assert rows["LATE"]["card_credit"] == 52.5
    assert rows["LATE"]["card_credit_from"] == "EARLY"
    assert rows["MAXI"]["card_credit"] == 0.0
    assert rows["EARLY"]["card_credit"] == 0.0
    assert rows["EARLY"]["card_credit_from"] == ""


def test_cancelled_transfers_and_cash_sends_carry_no_credit(
    client, test_store_id, admin,
):
    _batch(test_store_id, "C1", date(2026, 3, 3))
    _batch(test_store_id, "C2", date(2026, 3, 4))
    _send(test_store_id, "C1", amount=100, fee=5, card=True,
          status="Cancelled")
    _send(test_store_id, "C1", amount=70, service="Payout",
          status="Cancelled")
    _send(test_store_id, "C1", amount=80, fee=4)
    rows = _rows(client, admin)
    assert rows["C1"]["card_credit_next"] == 0.0
    assert rows["C1"]["payout_credit_next"] == 0.0
    assert rows["C2"]["card_credit"] == 0.0
    assert rows["C2"]["payout_credit"] == 0.0
    assert rows["C1"]["transfers_total"] == 80.0


def test_payout_is_credited_on_the_next_batch(client, test_store_id, admin):
    """A payout is never invoiced; the company credits the amount paid
    out on its next ACH, alongside any debit card credit."""
    _batch(test_store_id, "Y1", date(2026, 3, 3), ach_amount=80.0)
    _batch(test_store_id, "Y2", date(2026, 3, 4), ach_amount=34.0)
    _send(test_store_id, "Y1", amount=80, fee=4)
    _send(test_store_id, "Y1", amount=60, service="Payout")
    _send(test_store_id, "Y1", amount=100, fee=5, tax=1, card=True)
    _send(test_store_id, "Y2", amount=200)

    rows = _rows(client, admin)
    y1, y2 = rows["Y1"], rows["Y2"]
    # The payout adds nothing owed on its own batch.
    assert y1["transfers_total"] == 181.0
    assert y1["payout_credit_next"] == 60.0
    assert y1["card_credit_next"] == 106.0
    assert y1["card_credit_next_to"] == "Y2"
    # Y2: 200 owed, less 106 card + 60 payout from Y1.
    assert y2["card_credit"] == 106.0
    assert y2["payout_credit"] == 60.0
    assert y2["expected_ach"] == 34.0
    assert y2["variance"] == 0.0


def test_payout_credit_is_pending_without_a_next_batch(
    client, test_store_id, admin,
):
    _batch(test_store_id, "Z1", date(2026, 3, 3))
    _send(test_store_id, "Z1", amount=45, service="Payout")
    row = _rows(client, admin)["Z1"]
    assert row["payout_credit_next"] == 45.0
    assert row["card_credit_next_to"] == ""
    assert row["expected_ach"] == 0.0


def test_detail_and_edit_responses_carry_the_credit(
    client, test_store_id, admin,
):
    _batch(test_store_id, "D1", date(2026, 3, 3))
    b2 = _batch(test_store_id, "D2", date(2026, 3, 4))
    _send(test_store_id, "D1", amount=100, fee=5, tax=1, card=True)
    _send(test_store_id, "D2", amount=150, tax=1.5)

    got = client.get(f"/api/v2/batches/{b2}", headers=admin).json()["batch"]
    assert got["card_credit"] == 106.0
    assert got["expected_ach"] == 45.5

    put = client.put(f"/api/v2/batches/{b2}", headers=admin, json={
        "ach_date": "2026-03-04", "company": "Intermex",
        "batch_ref": "D2", "ach_amount": 45.5,
    })
    assert put.status_code == 200, put.text
    assert put.json()["batch"]["variance"] == 0.0
    assert put.json()["batch"]["card_credit_from"] == "D1"


def test_model_variance_counts_the_credit(test_store_id):
    """The dashboard's recent batches read ``ACHBatch.variance``."""
    from api.Modules.Batches.Models import ACHBatch
    _batch(test_store_id, "M1", date(2026, 3, 3))
    b2 = _batch(test_store_id, "M2", date(2026, 3, 4), ach_amount=94.0)
    _send(test_store_id, "M1", amount=100, fee=5, tax=1, card=True)
    _send(test_store_id, "M1", amount=40, service="Payout")
    _send(test_store_id, "M2", amount=200)
    b2_amount = 200 - 106 - 40
    with db_session():
        b = db.session.get(ACHBatch, b2)
        b.ach_amount = b2_amount
        db.session.commit()
        assert b.credit_cents == 10600 + 4000
        assert b.variance == 0.0


def test_another_stores_batches_never_chain(
    client, test_store_id, admin,
):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other Store", slug="other-card-credit",
                      plan="trial")
        db.session.add(other)
        db.session.commit()
        other_id = other.id
    _batch(other_id, "O1", date(2026, 3, 3))
    _send(other_id, "O1", amount=100, fee=5, card=True)
    _batch(test_store_id, "S2", date(2026, 3, 4))
    row = _rows(client, admin)["S2"]
    assert row["card_credit"] == 0.0
    assert row["card_credit_from"] == ""


def _employee(client, sid, username, matrix):
    from api.Core.Permissions import set_user_permissions
    from api.Modules.Tenancy.Models import User
    from tests.conftest import login_employee
    with db_session():
        u = User(store_id=sid, username=username, role="employee",
                 is_active=True)
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()
        uid = u.id
    set_user_permissions(sid, uid, matrix)
    return _h(login_employee(client, sid, username, "emppass1234"))


def test_employee_without_batch_rights_is_refused(client, test_store_id):
    _batch(test_store_id, "E1", date(2026, 3, 3))
    hdrs = _employee(client, test_store_id, "nobatch", {"batches": {"read": False}})
    assert client.get("/api/v2/batches", headers=hdrs).status_code == 403


def test_employee_with_batch_read_sees_the_credit(client, test_store_id):
    _batch(test_store_id, "R1", date(2026, 3, 3))
    _batch(test_store_id, "R2", date(2026, 3, 4))
    _send(test_store_id, "R1", amount=100, fee=5, tax=1, card=True)
    hdrs = _employee(client, test_store_id, "batchreader",
                     {"batches": {"read": True}})
    resp = client.get("/api/v2/batches", headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = {r["batch_ref"]: r for r in resp.json()["rows"]}
    assert rows["R2"]["card_credit"] == 106.0
