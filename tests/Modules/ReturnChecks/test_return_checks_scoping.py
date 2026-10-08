"""Return-check routes: single-row GET, date validation, 404 paths and
cross-store isolation (another store's row looks like a missing one)."""
from tests._app import db, db_session
from tests.Modules.ReturnChecks.test_return_checks_controllers import (
    _login, _seed_rc,
)


def _other_store_rc():
    """A return check pinned to a second, unrelated store."""
    from api.Modules.Tenancy.Models import Store
    other = Store(name="Other RC Store", slug="other-rc-store",
                  email="other-rc@test.com", plan="trial")
    db.session.add(other)
    db.session.commit()
    return _seed_rc(other.id, customer_name="Foreign Co")


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _body(**over):
    body = {
        "bounced_on": "2026-04-15", "customer_name": "Acme",
        "company_name": "Acme LLC", "amount": 100.0,
    }
    body.update(over)
    return body


def test_get_one_round_trip(client, test_store_id):
    with db_session():
        rid = _seed_rc(test_store_id, customer_name="Lookup Co")
    token = _login(client, test_store_id)
    resp = client.get(f"/api/v2/return-checks/{rid}", headers=_auth(token))
    assert resp.status_code == 200
    assert resp.get_json()["return_check"]["customer_name"] == "Lookup Co"


def test_get_one_404_for_missing_and_other_store(client, test_store_id):
    with db_session():
        foreign = _other_store_rc()
    token = _login(client, test_store_id)
    assert client.get(
        "/api/v2/return-checks/99999", headers=_auth(token),
    ).status_code == 404
    assert client.get(
        f"/api/v2/return-checks/{foreign}", headers=_auth(token),
    ).status_code == 404


def test_get_and_payments_reject_storeless_superadmin(client):
    from tests.conftest import login_superadmin
    token = login_superadmin(client)
    assert client.get(
        "/api/v2/return-checks/1", headers=_auth(token),
    ).status_code == 403
    assert client.get(
        "/api/v2/return-checks/1/payments", headers=_auth(token),
    ).status_code == 403


def test_create_and_update_reject_bad_date_format(client, test_store_id):
    with db_session():
        rid = _seed_rc(test_store_id)
    token = _login(client, test_store_id)
    r1 = client.post("/api/v2/return-checks",
                     json=_body(bounced_on="04/15/2026"), headers=_auth(token))
    r2 = client.put(f"/api/v2/return-checks/{rid}",
                    json=_body(bounced_on="nope"), headers=_auth(token))
    assert r1.status_code == 422 and r2.status_code == 422
    with db_session():
        from api.Modules.ReturnChecks.Models import ReturnCheck
        assert db.session.query(ReturnCheck).filter_by(
            customer_name="Acme").count() == 0


def test_update_404_for_missing_and_other_store(client, test_store_id):
    with db_session():
        foreign = _other_store_rc()
    token = _login(client, test_store_id)
    assert client.put("/api/v2/return-checks/99999", json=_body(),
                      headers=_auth(token)).status_code == 404
    assert client.put(f"/api/v2/return-checks/{foreign}", json=_body(),
                      headers=_auth(token)).status_code == 404
    with db_session():
        from api.Modules.ReturnChecks.Models import ReturnCheck
        assert db.session.get(ReturnCheck, foreign).customer_name == "Foreign Co"


def test_transitions_404_for_missing_and_other_store(client, test_store_id):
    with db_session():
        foreign = _other_store_rc()
    token = _login(client, test_store_id)
    for action in ("mark-loss", "mark-fraud", "reopen"):
        for rid in (99999, foreign):
            resp = client.post(
                f"/api/v2/return-checks/{rid}/{action}", headers=_auth(token),
            )
            assert resp.status_code == 404, (action, rid)
    with db_session():
        from api.Modules.ReturnChecks.Models import ReturnCheck
        assert db.session.get(ReturnCheck, foreign).status == "pending"


def test_payments_hidden_for_other_store(client, test_store_id):
    with db_session():
        foreign = _other_store_rc()
    token = _login(client, test_store_id)
    assert client.get(f"/api/v2/return-checks/{foreign}/payments",
                      headers=_auth(token)).status_code == 404
    assert client.post(
        f"/api/v2/return-checks/{foreign}/payments",
        json={"paid_on": "2026-04-15", "amount": 10.0}, headers=_auth(token),
    ).status_code == 404


def test_record_payment_rejects_bad_date(client, test_store_id):
    with db_session():
        rid = _seed_rc(test_store_id)
    token = _login(client, test_store_id)
    resp = client.post(
        f"/api/v2/return-checks/{rid}/payments",
        json={"paid_on": "15-04-2026", "amount": 10.0}, headers=_auth(token),
    )
    assert resp.status_code == 422
    assert client.get(f"/api/v2/return-checks/{rid}/payments",
                      headers=_auth(token)).get_json()["payments"] == []


def test_delete_payment_404_when_check_missing_or_foreign(client, test_store_id):
    with db_session():
        foreign = _other_store_rc()
    token = _login(client, test_store_id)
    for rid in (99999, foreign):
        resp = client.delete(
            f"/api/v2/return-checks/{rid}/payments/1", headers=_auth(token),
        )
        assert resp.status_code == 404
