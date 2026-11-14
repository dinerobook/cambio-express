"""Returned batches, company / customer tracking and the new optional
fields on a returned check: grant, deny, revoke, success and failure,
plus the guarantees that existing checks and old clients keep working
exactly as before."""
from datetime import date

from tests._app import db, db_session
from tests.conftest import make_employee_client
from tests.Modules.ReturnChecks.test_return_checks_controllers import (
    _login, _seed_rc,
)

BASE = "/api/v2/return-checks"


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _check(**over):
    body = {
        "customer_name": "Ana Lopez", "company_name": "Acme LLC",
        "check_number": "1001", "payer_bank": "Chase",
        "amount": 400.0, "return_check_fee": 25.0,
    }
    body.update(over)
    return body


def _batch_body(**over):
    body = {
        "returned_on": "2026-11-10", "reference": "RTN-77",
        "notes": "Chase notice",
        "checks": [
            _check(),
            _check(customer_name="Luis Perez", company_name="ACME, llc.",
                   check_number="2002", amount=150.0, return_check_fee=0,
                   routing_number="021000021", account_number="123456789"),
        ],
    }
    body.update(over)
    return body


def _other_store():
    from api.Modules.Tenancy.Models import Store
    other = Store(name="Other Batch Store", slug="other-batch-store",
                  email="other-batch@test.com", plan="trial")
    db.session.add(other)
    db.session.commit()
    return other.id


def _revoke(store_id, **actions):
    from api.Core.Permissions import get_permission_matrix, set_store_permissions
    cur = get_permission_matrix(store_id, ["employee"], ["employee"])["matrix"]["employee"]
    cur["return_checks"] = {
        "read": False, "create": False, "update": False, "delete": False, **actions,
    }
    set_store_permissions(store_id, "employee", cur)


def _audit_actions():
    from api.Modules.Audit.Models import OperatorAuditLog
    return [r.action for r in db.session.query(OperatorAuditLog).all()]


# ── Create a batch ──────────────────────────────────────────


def test_create_batch_saves_every_check_on_the_batch_day(client, test_store_id):
    token = _login(client, test_store_id)
    resp = client.post(f"{BASE}/batches", json=_batch_body(), headers=_auth(token))
    assert resp.status_code == 201
    data = resp.get_json()
    batch = data["batch"]
    assert batch["returned_on"] == "2026-11-10"
    assert batch["reference"] == "RTN-77"
    assert batch["check_count"] == 2
    assert batch["amount_total"] == 550.0
    assert batch["fee_total"] == 25.0
    assert batch["open_count"] == 2
    assert batch["companies"] == ["Acme LLC", "ACME, llc."]
    assert {c["bounced_on"] for c in data["checks"]} == {"2026-11-10"}
    assert {c["batch_id"] for c in data["checks"]} == {batch["id"]}
    assert {c["batch_reference"] for c in data["checks"]} == {"RTN-77"}
    assert {c["status"] for c in data["checks"]} == {"pending"}
    luis = next(c for c in data["checks"] if c["customer_name"] == "Luis Perez")
    assert luis["routing_number"] == "021000021"
    assert luis["account_number"] == "123456789"
    with db_session():
        actions = _audit_actions()
    assert actions.count("create_return_check_batch") == 1
    assert actions.count("create_return_check") == 2


def test_create_batch_refuses_bad_input_and_writes_nothing(client, test_store_id):
    token = _login(client, test_store_id)
    h = _auth(token)
    bad = [
        _batch_body(checks=[]),
        _batch_body(returned_on="11/10/2026"),
        _batch_body(checks=[_check(amount=0)]),
        _batch_body(checks=[_check(company_name="")]),
        _batch_body(checks=[_check(routing_number="12345")]),
        _batch_body(checks=[_check(account_number="12-34")]),
        _batch_body(checks=[_check(return_check_fee=-1)]),
        _batch_body(checks=[_check()] * 51),
    ]
    for body in bad:
        assert client.post(f"{BASE}/batches", json=body, headers=h).status_code == 422
    with db_session():
        from api.Modules.ReturnChecks.Models import ReturnCheck, ReturnCheckBatch
        assert db.session.query(ReturnCheckBatch).count() == 0
        assert db.session.query(ReturnCheck).count() == 0


def test_employee_reads_batches_but_cannot_create_by_default(client, test_store_id):
    admin = _auth(_login(client, test_store_id))
    created = client.post(f"{BASE}/batches", json=_batch_body(), headers=admin).get_json()
    emp_client, jwt = make_employee_client(test_store_id)
    h = _auth(jwt)
    assert emp_client.get(f"{BASE}/batches", headers=h).status_code == 200
    assert emp_client.get(
        f"{BASE}/batches/{created['batch']['id']}", headers=h,
    ).status_code == 200
    assert emp_client.get(f"{BASE}/tracking", headers=h).status_code == 200
    assert emp_client.post(f"{BASE}/batches", json=_batch_body(), headers=h).status_code == 403
    assert emp_client.put(
        f"{BASE}/batches/{created['batch']['id']}",
        json={"returned_on": "2026-11-11"}, headers=h,
    ).status_code == 403
    assert emp_client.delete(
        f"{BASE}/batches/{created['batch']['id']}", headers=h,
    ).status_code == 403


def test_granted_employee_can_create_and_revoked_one_cannot_read(client, test_store_id):
    with db_session():
        _revoke(test_store_id, read=True, create=True)
    emp_client, jwt = make_employee_client(test_store_id)
    h = _auth(jwt)
    assert emp_client.post(f"{BASE}/batches", json=_batch_body(), headers=h).status_code == 201
    with db_session():
        _revoke(test_store_id)
    assert emp_client.get(f"{BASE}/batches", headers=h).status_code == 403
    assert emp_client.get(f"{BASE}/tracking", headers=h).status_code == 403
    assert emp_client.get(f"{BASE}/batches/1", headers=h).status_code == 403


def test_signed_out_and_storeless_superadmin_are_refused(client):
    from tests.conftest import login_superadmin
    assert client.get(f"{BASE}/batches").status_code == 401
    assert client.get(f"{BASE}/tracking").status_code == 401
    token = login_superadmin(client)
    assert client.get(f"{BASE}/batches", headers=_auth(token)).status_code == 403
    assert client.get(f"{BASE}/tracking", headers=_auth(token)).status_code == 403


# ── List, read, edit, delete a batch ────────────────────────


def test_batch_list_totals_search_and_paging(client, test_store_id):
    h = _auth(_login(client, test_store_id))
    client.post(f"{BASE}/batches", json=_batch_body(), headers=h)
    client.post(f"{BASE}/batches", json=_batch_body(
        returned_on="2026-11-12", reference="RTN-88",
        checks=[_check(customer_name="Maria Diaz", company_name="Beta Corp")],
    ), headers=h)
    rows = client.get(f"{BASE}/batches", headers=h).get_json()["rows"]
    assert [r["reference"] for r in rows] == ["RTN-88", "RTN-77"]
    found = client.get(f"{BASE}/batches?q=maria", headers=h).get_json()
    assert [r["reference"] for r in found["rows"]] == ["RTN-88"]
    found = client.get(f"{BASE}/batches?q=rtn-77", headers=h).get_json()
    assert [r["reference"] for r in found["rows"]] == ["RTN-77"]
    paged = client.get(f"{BASE}/batches?per_page=1&page=2", headers=h).get_json()
    assert paged["total"] == 2 and paged["total_pages"] == 2
    assert [r["reference"] for r in paged["rows"]] == ["RTN-77"]
    asc = client.get(f"{BASE}/batches?sort=returned&dir=asc", headers=h).get_json()
    assert [r["reference"] for r in asc["rows"]] == ["RTN-77", "RTN-88"]


def test_batch_detail_and_other_store_isolation(client, test_store_id):
    h = _auth(_login(client, test_store_id))
    bid = client.post(f"{BASE}/batches", json=_batch_body(), headers=h).get_json()["batch"]["id"]
    detail = client.get(f"{BASE}/batches/{bid}", headers=h).get_json()
    assert len(detail["checks"]) == 2
    assert client.get(f"{BASE}/batches/99999", headers=h).status_code == 404
    # A batch from another store looks missing everywhere.
    with db_session():
        from api.Modules.ReturnChecks.Models import ReturnCheckBatch
        other = _other_store()
        foreign = ReturnCheckBatch(store_id=other, returned_on=date(2026, 11, 1))
        db.session.add(foreign)
        db.session.commit()
        fid = foreign.id
    assert client.get(f"{BASE}/batches/{fid}", headers=h).status_code == 404
    assert client.put(f"{BASE}/batches/{fid}", json={"returned_on": "2026-11-02"},
                      headers=h).status_code == 404
    assert client.delete(f"{BASE}/batches/{fid}", headers=h).status_code == 404
    assert client.post(BASE, json={**_check(), "bounced_on": "2026-11-01",
                                   "batch_id": fid}, headers=h).status_code == 404
    assert fid not in [r["id"] for r in client.get(f"{BASE}/batches", headers=h).get_json()["rows"]]


def test_editing_the_batch_date_moves_its_checks_only(client, test_store_id):
    h = _auth(_login(client, test_store_id))
    bid = client.post(f"{BASE}/batches", json=_batch_body(), headers=h).get_json()["batch"]["id"]
    with db_session():
        loose = _seed_rc(test_store_id, customer_name="Loose", bounced_on_=date(2026, 10, 1))
    resp = client.put(f"{BASE}/batches/{bid}", json={
        "returned_on": "2026-11-09", "reference": "RTN-77b", "notes": "fixed",
    }, headers=h)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["batch"]["reference"] == "RTN-77b"
    assert {c["bounced_on"] for c in data["checks"]} == {"2026-11-09"}
    assert client.get(f"{BASE}/{loose}", headers=h).get_json()[
        "return_check"]["bounced_on"] == "2026-10-01"
    assert client.put(f"{BASE}/batches/{bid}", json={"returned_on": "bad"},
                      headers=h).status_code == 422
    with db_session():
        assert "update_return_check_batch" in _audit_actions()


def test_delete_refuses_a_batch_with_checks_and_deletes_an_empty_one(client, test_store_id):
    h = _auth(_login(client, test_store_id))
    data = client.post(f"{BASE}/batches", json=_batch_body(), headers=h).get_json()
    bid = data["batch"]["id"]
    resp = client.delete(f"{BASE}/batches/{bid}", headers=h)
    assert resp.status_code == 409
    assert "still has checks" in resp.get_json()["detail"]
    # Move both checks out (clear their batch), then the delete goes through.
    for c in data["checks"]:
        body = {k: c[k] for k in ("bounced_on", "customer_name", "company_name",
                                  "check_number", "payer_bank", "amount",
                                  "return_check_fee", "notes")}
        assert client.put(f"{BASE}/{c['id']}", json={**body, "batch_id": None},
                          headers=h).status_code == 200
    assert client.delete(f"{BASE}/batches/{bid}", headers=h).get_json() == {"ok": True}
    assert client.get(f"{BASE}/batches/{bid}", headers=h).status_code == 404
    with db_session():
        assert "delete_return_check_batch" in _audit_actions()
    # The checks themselves stay.
    assert client.get(f"{BASE}/{data['checks'][0]['id']}", headers=h).status_code == 200


# ── A single check and its batch ────────────────────────────


def test_single_check_joins_a_batch_and_takes_its_date(client, test_store_id):
    h = _auth(_login(client, test_store_id))
    bid = client.post(f"{BASE}/batches", json=_batch_body(), headers=h).get_json()["batch"]["id"]
    resp = client.post(BASE, json={**_check(customer_name="Third"),
                                   "bounced_on": "2026-01-01", "batch_id": bid,
                                   "routing_number": "011000015"}, headers=h)
    assert resp.status_code == 201
    rc = resp.get_json()["return_check"]
    assert rc["batch_id"] == bid and rc["bounced_on"] == "2026-11-10"
    assert rc["routing_number"] == "011000015"
    assert client.get(f"{BASE}/batches/{bid}", headers=h).get_json()["batch"]["check_count"] == 3
    assert client.post(BASE, json={**_check(), "bounced_on": "2026-01-01",
                                   "batch_id": 99999}, headers=h).status_code == 404


def test_old_page_edit_keeps_batch_and_routing(client, test_store_id):
    """A page that predates batches sends none of the new fields; the
    check keeps its batch, routing and account number."""
    h = _auth(_login(client, test_store_id))
    data = client.post(f"{BASE}/batches", json=_batch_body(), headers=h).get_json()
    luis = next(c for c in data["checks"] if c["customer_name"] == "Luis Perez")
    old_body = {
        "bounced_on": "2026-11-10", "customer_name": "Luis Perez",
        "company_name": "ACME, llc.", "amount": 175.0,
    }
    rc = client.put(f"{BASE}/{luis['id']}", json=old_body, headers=h).get_json()["return_check"]
    assert rc["amount"] == 175.0
    assert rc["batch_id"] == data["batch"]["id"]
    assert rc["routing_number"] == "021000021"
    assert rc["account_number"] == "123456789"
    # Sent empty, routing / account clear.
    rc = client.put(f"{BASE}/{luis['id']}", json={
        **old_body, "routing_number": "", "account_number": "",
    }, headers=h).get_json()["return_check"]
    assert rc["routing_number"] == "" and rc["account_number"] == ""


def test_existing_checks_read_as_before(client, test_store_id):
    with db_session():
        rid = _seed_rc(test_store_id, customer_name="Legacy Co")
    h = _auth(_login(client, test_store_id))
    rc = client.get(f"{BASE}/{rid}", headers=h).get_json()["return_check"]
    assert rc["batch_id"] is None
    assert rc["batch_reference"] == ""
    assert rc["routing_number"] == "" and rc["account_number"] == ""


def test_payback_on_a_batched_check_still_feeds_the_daily_book(client, test_store_id):
    h = _auth(_login(client, test_store_id))
    data = client.post(f"{BASE}/batches", json=_batch_body(), headers=h).get_json()
    ana = next(c for c in data["checks"] if c["customer_name"] == "Ana Lopez")
    resp = client.post(f"{BASE}/{ana['id']}/payments", json={
        "paid_on": "2026-11-12", "amount": 425.0, "method": "cash",
    }, headers=h)
    assert resp.status_code == 201
    assert resp.get_json()["return_check"]["status"] == "recovered"
    with db_session():
        from api.Modules.DailyBook.Models import DailyLineItem
        items = db.session.query(DailyLineItem).filter_by(
            return_check_id=ana["id"], kind="return_payback").all()
        assert [float(i.amount) for i in items] == [425.0]
    batch = client.get(f"{BASE}/batches/{data['batch']['id']}", headers=h).get_json()["batch"]
    assert batch["recovered_total"] == 425.0 and batch["open_count"] == 1


# ── The check list's new filters ────────────────────────────


def test_check_list_search_batch_and_party_filters(client, test_store_id):
    h = _auth(_login(client, test_store_id))
    bid = client.post(f"{BASE}/batches", json=_batch_body(), headers=h).get_json()["batch"]["id"]
    with db_session():
        _seed_rc(test_store_id, customer_name="Zed 100%")
    def names(qs):
        return sorted(r["customer_name"] for r in client.get(
            f"{BASE}?page=1&{qs}", headers=h).get_json()["rows"])
    assert names("q=luis") == ["Luis Perez"]
    assert names("q=chase") == ["Ana Lopez", "Luis Perez"]
    assert names("q=0210000") == ["Luis Perez"]
    assert names("q=100%25") == ["Zed 100%"]
    assert names("q=%25") == ["Zed 100%"]  # % is matched literally
    assert names(f"batch_id={bid}") == ["Ana Lopez", "Luis Perez"]
    assert names("company=acme%20llc") == ["Ana Lopez", "Luis Perez"]
    assert names("customer=ana%20lopez") == ["Ana Lopez"]
    assert names("company=nobody") == []
    assert names("sort=company&dir=asc")[0] == "Ana Lopez"


# ── Tracking by company and customer ────────────────────────


def test_tracking_groups_by_company_with_owed_and_written_off(client, test_store_id):
    h = _auth(_login(client, test_store_id))
    client.post(f"{BASE}/batches", json=_batch_body(), headers=h)
    beta = client.post(f"{BASE}/batches", json=_batch_body(
        returned_on="2026-11-12", reference="RTN-88",
        checks=[_check(customer_name="Ana  LÓPEZ", company_name="Beta Corp",
                       amount=1000.0, return_check_fee=0)],
    ), headers=h).get_json()
    client.post(f"{BASE}/{beta['checks'][0]['id']}/mark-loss", headers=h)
    resp = client.get(f"{BASE}/tracking?by=company", headers=h)
    assert resp.status_code == 200
    rows = resp.get_json()["rows"]
    acme, beta_row = rows
    assert acme["key"] == "acme llc"
    assert acme["name"] == "ACME, llc."        # latest spelling
    assert acme["check_count"] == 2
    assert acme["amount_total"] == 550.0
    assert acme["owed_total"] == 575.0         # face + fee, still open
    assert acme["open_count"] == 2
    assert acme["lost_count"] == 0
    assert acme["routing_number"] == "021000021"
    assert acme["last_returned_on"] == "2026-11-10"
    assert beta_row["key"] == "beta corp"
    assert beta_row["lost_count"] == 1 and beta_row["lost_total"] == 1000.0
    assert beta_row["owed_total"] == 0.0
    by_amount = client.get(f"{BASE}/tracking?by=company&sort=amount", headers=h).get_json()
    assert [r["key"] for r in by_amount["rows"]] == ["beta corp", "acme llc"]


def test_tracking_by_customer_merges_spellings_and_filters(client, test_store_id):
    h = _auth(_login(client, test_store_id))
    client.post(f"{BASE}/batches", json=_batch_body(), headers=h)
    client.post(f"{BASE}/batches", json=_batch_body(
        returned_on="2026-11-12",
        checks=[_check(customer_name="ana  lópez.", company_name="Beta Corp")],
    ), headers=h)
    rows = client.get(f"{BASE}/tracking?by=customer", headers=h).get_json()["rows"]
    assert [(r["key"], r["check_count"]) for r in rows] == [
        ("ana lopez", 2), ("luis perez", 1),
    ]
    assert rows[0]["routing_number"] == ""
    found = client.get(f"{BASE}/tracking?by=customer&q=LUIS", headers=h).get_json()
    assert [r["key"] for r in found["rows"]] == ["luis perez"]
    period = client.get(
        f"{BASE}/tracking?by=customer&from=2026-11-11&to=2026-11-30", headers=h,
    ).get_json()
    assert [(r["key"], r["check_count"]) for r in period["rows"]] == [("ana lopez", 1)]
    paged = client.get(f"{BASE}/tracking?by=customer&per_page=1&page=2", headers=h).get_json()
    assert paged["total"] == 2 and [r["key"] for r in paged["rows"]] == ["luis perez"]
    assert client.get(f"{BASE}/tracking?by=bank", headers=h).status_code == 422
    assert client.get(f"{BASE}/tracking?by=customer&from=11/01/2026",
                      headers=h).status_code == 422


def test_tracking_ignores_other_stores(client, test_store_id):
    with db_session():
        other = _other_store()
        _seed_rc(other, customer_name="Foreign Person")
    h = _auth(_login(client, test_store_id))
    rows = client.get(f"{BASE}/tracking?by=customer", headers=h).get_json()["rows"]
    assert "foreign person" not in [r["key"] for r in rows]


def test_party_key_rule():
    from api.Modules.ReturnChecks.parties import party_key
    assert party_key("  ACME, Inc. ") == "acme inc"
    assert party_key("José  Núñez") == party_key("jose nunez")
    assert party_key("Acme LLC") != party_key("Acme")
    assert party_key(None) == "" and party_key("...") == ""


def test_retention_purges_batches_with_their_store(client, test_store_id):
    from api.Modules.Billing.Services.retention import STORE_OWNED_MODELS
    assert STORE_OWNED_MODELS.index("ReturnCheck") < STORE_OWNED_MODELS.index("ReturnCheckBatch")
