"""Debit card sends and payouts on the transfer ledger.

* A debit card send is a normal send the customer paid on the
  company's card terminal: same money math, same tax, but no cash
  reached the drawer (``payment_method = "debit_card"``).
* A payout (``service_type = "Payout"``) is the store paying cash to a
  recipient: no federal tax, no fee, always cash, and never counted as
  money sent in a volume total.

See api/Modules/Transfers/INVARIANTS.md "Debit card sends" / "Payouts".
"""
import itertools
from datetime import date

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee

DAY = date(2026, 3, 9)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def admin(client, test_store_id):
    return _h(login_admin(client, test_store_id))


@pytest.fixture
def emp_id(test_store_id):
    from api.Modules.Tenancy.Models import StoreEmployee
    with db_session():
        e = StoreEmployee(store_id=test_store_id, name="Card Cashier",
                          is_active=True)
        db.session.add(e)
        db.session.commit()
        return e.id


_phones = itertools.count(5550100000)


def _body(emp_id, **over):
    # A distinct phone per body: these tests are about payment method
    # and payouts, not the customer directory.
    body = {
        "sender_phone": str(next(_phones)),
        "send_date": DAY.isoformat(),
        "company": "Intermex",
        "service_type": "Money Transfer",
        "sender_name": "Ana Sender",
        "send_amount": 200.0,
        "fee": 8.0,
        "country": "Mexico",
        "recipient_name": "Luis",
        "employee_id": emp_id,
    }
    body.update(over)
    return body


def _count(store_id):
    from api.Modules.Transfers.Models import Transfer
    with db_session():
        return db.session.query(Transfer).filter_by(store_id=store_id).count()


def _employee(client, sid, username, matrix):
    from api.Core.Permissions import set_user_permissions
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=sid, username=username, role="employee",
                 is_active=True)
        u.set_password("emppass1234")
        db.session.add(u)
        db.session.commit()
        uid = u.id
    set_user_permissions(sid, uid, matrix)
    return _h(login_employee(client, sid, username, "emppass1234"))


# ── Create ─────────────────────────────────────────────────


def test_omitted_payment_method_is_cash(client, test_store_id, admin, emp_id):
    """Every client that predates the field keeps saving cash sends."""
    resp = client.post("/api/v2/transfers", headers=admin, json=_body(emp_id))
    assert resp.status_code == 201, resp.get_data(as_text=True)
    assert resp.get_json()["transfer"]["payment_method"] == "cash"


def test_debit_card_send_keeps_the_money_math(client, test_store_id, admin, emp_id):
    resp = client.post("/api/v2/transfers", headers=admin,
                       json=_body(emp_id, payment_method="debit_card"))
    assert resp.status_code == 201, resp.get_data(as_text=True)
    row = resp.get_json()["transfer"]
    assert row["payment_method"] == "debit_card"
    # Still a send to Mexico: the tax applies and the total is the
    # usual send + fee + tax (what the card was charged).
    assert row["federal_tax"] > 0
    assert row["total_collected"] == pytest.approx(
        row["send_amount"] + row["fee"] + row["federal_tax"])
    from api.Modules.Transfers.Models import Transfer
    with db_session():
        t = db.session.get(Transfer, row["id"])
        assert t.payment_method == "debit_card"
        assert t.is_debit_card and t.is_send


def test_payout_saves_with_no_tax(client, test_store_id, admin, emp_id):
    resp = client.post("/api/v2/transfers", headers=admin, json=_body(
        emp_id, service_type="Payout", fee=0.0, send_amount=350.0,
        commission=2.0,
    ))
    assert resp.status_code == 201, resp.get_data(as_text=True)
    row = resp.get_json()["transfer"]
    assert row["service_type"] == "Payout"
    assert row["payment_method"] == "cash"
    assert row["federal_tax"] == 0.0
    assert row["total_collected"] == 350.0


def test_payout_by_debit_card_is_refused(client, test_store_id, admin, emp_id):
    before = _count(test_store_id)
    resp = client.post("/api/v2/transfers", headers=admin, json=_body(
        emp_id, service_type="Payout", fee=0.0, payment_method="debit_card",
    ))
    assert resp.status_code == 422
    assert "can't be paid by debit card" in resp.get_data(as_text=True)
    assert _count(test_store_id) == before


def test_payout_with_a_fee_is_refused(client, test_store_id, admin, emp_id):
    before = _count(test_store_id)
    resp = client.post("/api/v2/transfers", headers=admin, json=_body(
        emp_id, service_type="Payout", fee=4.0,
    ))
    assert resp.status_code == 422
    assert "no fee" in resp.get_data(as_text=True)
    assert _count(test_store_id) == before


def test_unknown_payment_method_is_a_422(client, test_store_id, admin, emp_id):
    resp = client.post("/api/v2/transfers", headers=admin,
                       json=_body(emp_id, payment_method="check"))
    assert resp.status_code == 422


def test_create_needs_the_create_right(client, test_store_id, emp_id):
    """A payout or a debit card send is a transfer like any other:
    read-only → 403, nothing saved; with create → 201."""
    reader = _employee(client, test_store_id, "po_ro",
                       {"transfers": {"read": True}})
    before = _count(test_store_id)
    for body in (_body(emp_id, service_type="Payout", fee=0.0),
                 _body(emp_id, payment_method="debit_card")):
        assert client.post("/api/v2/transfers", headers=reader,
                           json=body).status_code == 403
    assert _count(test_store_id) == before

    writer = _employee(client, test_store_id, "po_rw",
                       {"transfers": {"read": True, "create": True}})
    for body in (_body(emp_id, service_type="Payout", fee=0.0),
                 _body(emp_id, payment_method="debit_card")):
        resp = client.post("/api/v2/transfers", headers=writer, json=body)
        assert resp.status_code == 201, resp.get_data(as_text=True)
    assert _count(test_store_id) == before + 2


# ── Update + audit ─────────────────────────────────────────


def _audits(tid):
    from api.Modules.Audit.Models import TransferAudit
    with db_session():
        return [a.summary for a in db.session.query(TransferAudit)
                .filter_by(transfer_id=tid).order_by(TransferAudit.id)]


def test_edit_to_debit_card_is_audited(client, test_store_id, admin, emp_id):
    tid = client.post("/api/v2/transfers", headers=admin,
                      json=_body(emp_id)).get_json()["transfer"]["id"]
    resp = client.put(f"/api/v2/transfers/{tid}", headers=admin,
                      json=_body(emp_id, payment_method="debit_card"))
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.get_json()["transfer"]["payment_method"] == "debit_card"
    assert "Paid by: Cash → Debit card" in _audits(tid)[-1]


def test_editing_an_old_row_does_not_log_a_payment_change(
    client, test_store_id, admin, emp_id,
):
    """A row saved before the column existed (NULL) reads as cash, so
    saving it unchanged as "cash" changes nothing in the audit."""
    from api.Modules.Transfers.Models import Transfer
    with db_session():
        t = Transfer(store_id=test_store_id, send_date=DAY,
                     company="Intermex", service_type="Money Transfer",
                     sender_name="Ana Sender", send_amount=200.0, fee=8.0,
                     country="Mexico", recipient_name="Luis",
                     employee_id=emp_id, employee_name="Card Cashier")
        db.session.add(t)
        db.session.commit()
        tid = t.id
        assert t.payment_method is None and t.paid_by == "Cash"
    resp = client.put(f"/api/v2/transfers/{tid}", headers=admin,
                      json=_body(emp_id, payment_method="cash"))
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert "Paid by" not in _audits(tid)[-1]


def test_edit_cannot_turn_a_row_into_a_debit_card_payout(
    client, test_store_id, admin, emp_id,
):
    tid = client.post("/api/v2/transfers", headers=admin,
                      json=_body(emp_id)).get_json()["transfer"]["id"]
    resp = client.put(f"/api/v2/transfers/{tid}", headers=admin, json=_body(
        emp_id, service_type="Payout", fee=0.0, payment_method="debit_card",
    ))
    assert resp.status_code == 422
    from api.Modules.Transfers.Models import Transfer
    with db_session():
        t = db.session.get(Transfer, tid)
        assert t.service_type == "Money Transfer"
        assert t.payment_method == "cash"


def test_edit_send_to_payout_drops_the_tax(client, test_store_id, admin, emp_id):
    created = client.post("/api/v2/transfers", headers=admin,
                          json=_body(emp_id)).get_json()["transfer"]
    assert created["federal_tax"] > 0
    resp = client.put(f"/api/v2/transfers/{created['id']}", headers=admin,
                      json=_body(emp_id, service_type="Payout", fee=0.0))
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.get_json()["transfer"]["federal_tax"] == 0.0


# ── List + receipt ─────────────────────────────────────────


@pytest.fixture
def three_kinds(test_store_id):
    """One cash send, one debit card send, one payout, one legacy row
    (NULL payment method)."""
    from api.Modules.Transfers.Models import Transfer
    rows = [
        dict(sender_name="Cash", send_amount=100.0, fee=5.0,
             payment_method="cash"),
        dict(sender_name="Card", send_amount=60.0, fee=4.0,
             payment_method="debit_card"),
        dict(sender_name="Paid", send_amount=300.0, fee=0.0,
             service_type="Payout", payment_method="cash"),
        dict(sender_name="Legacy", send_amount=10.0, fee=1.0),
    ]
    with db_session():
        for r in rows:
            db.session.add(Transfer(
                store_id=test_store_id, send_date=DAY, company="Maxi",
                **{"service_type": "Money Transfer", **r},
            ))
        db.session.commit()


def _list(client, admin, sid, **params):
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    resp = client.get(f"/api/v2/transfers?store_ids={sid}&{qs}", headers=admin)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()


def test_list_filters_by_service_and_paid_by(client, test_store_id, admin, three_kinds):
    names = lambda body: sorted(r["sender_name"] for r in body["rows"])  # noqa: E731
    assert names(_list(client, admin, test_store_id, service="Payout")) == ["Paid"]
    assert names(_list(client, admin, test_store_id, paid_by="debit_card")) == ["Card"]
    # Cash includes the row saved before the field existed.
    assert names(_list(client, admin, test_store_id, paid_by="cash")) == [
        "Cash", "Legacy", "Paid"]
    # An unknown value drops the filter rather than hiding everything.
    assert len(_list(client, admin, test_store_id, paid_by="zzz")["rows"]) == 4
    rows = {r["sender_name"]: r for r in _list(client, admin, test_store_id)["rows"]}
    assert rows["Legacy"]["payment_method"] == "cash"
    assert rows["Card"]["payment_method"] == "debit_card"


def test_page_amount_leaves_payouts_out(client, test_store_id, admin, three_kinds):
    body = _list(client, admin, test_store_id)
    # 105 + 64 + 11 collected; the 300 paid out is not money collected.
    assert body["page_amount"] == pytest.approx(180.0)


def test_receipt_carries_the_payment_method(client, test_store_id, admin, emp_id):
    tid = client.post("/api/v2/transfers", headers=admin, json=_body(
        emp_id, payment_method="debit_card",
    )).get_json()["transfer"]["id"]
    resp = client.get(
        f"/api/v2/transfers/{tid}/receipt?store_ids={test_store_id}",
        headers=admin,
    )
    assert resp.status_code == 200
    assert resp.get_json()["transfer"]["payment_method"] == "debit_card"


# ── Volume totals elsewhere ────────────────────────────────


def test_batch_total_leaves_out_a_linked_payout(test_store_id):
    from api.Modules.Batches.Models import ACHBatch
    from api.Modules.Batches.Repositories.batches import (
        sum_transfer_totals_for_batch_refs, transfer_count_by_batch_ref,
    )
    from api.Modules.Transfers.Models import Transfer
    with db_session():
        db.session.add_all([
            Transfer(store_id=test_store_id, send_date=DAY, company="Maxi",
                     service_type="Money Transfer", sender_name="S",
                     send_amount=100.0, federal_tax=1.0, batch_id="B-PO"),
            Transfer(store_id=test_store_id, send_date=DAY, company="Maxi",
                     service_type="Money Transfer", sender_name="C",
                     payment_method="debit_card",
                     send_amount=50.0, federal_tax=0.5, batch_id="B-PO"),
            Transfer(store_id=test_store_id, send_date=DAY, company="Maxi",
                     service_type="Payout", sender_name="P",
                     send_amount=400.0, batch_id="B-PO"),
        ])
        batch = ACHBatch(store_id=test_store_id, ach_date=DAY, company="Maxi",
                         batch_ref="B-PO", ach_amount=151.5)
        db.session.add(batch)
        db.session.commit()
        assert batch.transfers_total == 151.5
        assert batch.variance == 0
        assert batch.transfer_count == 2
        assert sum_transfer_totals_for_batch_refs(
            db.session, test_store_id, ["B-PO"]) == {"B-PO": 151.5}
        assert transfer_count_by_batch_ref(
            db.session, test_store_id, ["B-PO"]) == {"B-PO": 2}


def test_employee_dashboard_totals_split_sent_and_paid_out(
    client, test_store_id, admin, emp_id,
):
    from api.Modules.Admin.Services.store_hours import store_now
    from api.Modules.Tenancy.Models import Store
    with db_session():
        store = db.session.get(Store, test_store_id)
        today = store_now(store.timezone).date().isoformat()
    for body in (
        _body(emp_id, send_date=today, send_amount=100.0, fee=5.0),
        _body(emp_id, send_date=today, send_amount=40.0, fee=2.0,
              payment_method="debit_card"),
        _body(emp_id, send_date=today, send_amount=250.0, fee=0.0,
              service_type="Payout"),
    ):
        assert client.post("/api/v2/transfers", headers=admin,
                           json=body).status_code == 201
    from api.Modules.Dashboard.Controllers import _employee_summary
    from api.Modules.Tenancy.Models import User
    with db_session():
        admin_user = db.session.query(User).filter_by(
            store_id=test_store_id, role="admin").first()
        claims = {"sub": str(admin_user.id), "role": "admin",
                  "store_id": test_store_id}
        data = _employee_summary(db.session, test_store_id, claims)
    if not data["today_transfers"]:
        pytest.skip("money services module off for the test store")
    kinds = {(r["service_type"], r["payment_method"]) for r in data["today_transfers"]}
    assert ("Payout", "cash") in kinds
    assert ("Money Transfer", "debit_card") in kinds
    assert data["totals"]["sent"] == 140.0
    assert data["totals"]["paid_out"] == 250.0
    assert data["totals"]["count"] == 3


# ── With the save-once key and phoneless senders (#950) ─────────────


@pytest.mark.parametrize("over", [
    {"payment_method": "debit_card"},
    {"service_type": "Payout", "fee": 0, "country": "United States"},
])
def test_repeat_save_with_the_same_key_logs_one_row(
    client, test_store_id, admin, emp_id, over,
):
    """Pressing Save again on a debit card send or a payout returns
    the first save and never logs the money twice."""
    before = _count(test_store_id)
    body = _body(emp_id, **over)
    hdrs = {**admin, "Idempotency-Key": f"key-{next(_phones)}"}
    first = client.post("/api/v2/transfers", headers=hdrs, json=body)
    again = client.post("/api/v2/transfers", headers=hdrs, json=body)
    assert first.status_code == 201, first.text
    assert again.status_code == 201, again.text
    assert again.json()["transfer"]["id"] == first.json()["transfer"]["id"]
    assert _count(test_store_id) == before + 1
    row = first.json()["transfer"]
    assert row["payment_method"] == over.get("payment_method", "cash")
    assert row["service_type"] == over.get("service_type", "Money Transfer")


def test_phoneless_payouts_and_card_sends_all_save(
    client, test_store_id, admin, emp_id,
):
    """Several senders with no phone, mixing payouts and card sends,
    each save as their own row."""
    before = _count(test_store_id)
    for over in (
        {"service_type": "Payout", "fee": 0},
        {"payment_method": "debit_card"},
        {"service_type": "Payout", "fee": 0},
    ):
        resp = client.post("/api/v2/transfers", headers=admin,
                           json=_body(emp_id, sender_phone="", **over))
        assert resp.status_code == 201, resp.text
    assert _count(test_store_id) == before + 3


def test_refused_payout_leaves_the_key_free(
    client, test_store_id, admin, emp_id,
):
    """A payout refused for its fee writes nothing, so the corrected
    save under the same key goes through."""
    hdrs = {**admin, "Idempotency-Key": "payout-fix-key"}
    bad = client.post("/api/v2/transfers", headers=hdrs, json=_body(
        emp_id, service_type="Payout", fee=5.0, sender_phone="7775550000"))
    assert bad.status_code == 422
    good = client.post("/api/v2/transfers", headers=hdrs, json=_body(
        emp_id, service_type="Payout", fee=0, sender_phone="7775550000"))
    assert good.status_code == 201, good.text
    assert good.json()["transfer"]["service_type"] == "Payout"
