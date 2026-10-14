"""GET /api/v2/owner/reports — the owner umbrella's report-center index.

Owner-only: the store-level index is /api/v2/reports. Pinned here:
an owner gets the registry with drill-down links on the owner
mirrors and without the store-only extras; a store admin, an
employee, the superadmin and an anonymous caller are refused.
"""
from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin, make_employee_client


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _owner_token(client):
    from api.Modules.Tenancy.Models import Store, User
    with db_session():
        s = Store(name="Owner Home", slug="owner-reports-home",
                  email="boss-rep@x.com", plan="basic")
        db.session.add(s)
        db.session.commit()
        u = User(store_id=s.id, username="boss-rep@x.com", full_name="Boss",
                 email="boss-rep@x.com", role="owner")
        u.set_password("ownerpass1!")
        db.session.add(u)
        db.session.commit()
    resp = client.post("/api/v2/auth/login-cross-store", json={
        "username": "boss-rep@x.com", "password": "ownerpass1!",
    })
    return resp.get_json()["access_token"]


def test_owner_gets_the_report_registry(client):
    resp = client.get("/api/v2/owner/reports", headers=_h(_owner_token(client)))
    assert resp.status_code == 200, resp.get_data(as_text=True)
    cats = resp.get_json()["categories"]
    assert cats, "the owner index lists at least one category"
    reports = [r for c in cats for r in c["reports"]]
    for r in reports:
        assert {"key", "label", "description", "url", "status"} <= set(r)
    ready = [r for r in reports if r["status"] == "ready" and r["url"]]
    assert ready, "at least one report is ready to open"
    assert all("/owner/" in r["url"] for r in ready), [r["url"] for r in ready]


def test_owner_index_leaves_out_the_store_only_pages(client, test_store_id):
    owner = client.get("/api/v2/owner/reports",
                       headers=_h(_owner_token(client))).get_json()
    store = client.get("/api/v2/reports",
                       headers=_h(login_admin(client, test_store_id))).get_json()
    owner_keys = {r["key"] for c in owner["categories"] for r in c["reports"]}
    store_keys = {r["key"] for c in store["categories"] for r in c["reports"]}
    assert owner_keys < store_keys, "the store index adds its extras on top"


def test_store_admin_is_refused(client, test_store_id):
    resp = client.get("/api/v2/owner/reports",
                      headers=_h(login_admin(client, test_store_id)))
    assert resp.status_code == 403
    assert "Owner scope required" in resp.get_data(as_text=True)


def test_employee_is_refused(client, test_store_id):
    _, jwt = make_employee_client(test_store_id)
    resp = client.get("/api/v2/owner/reports", headers=_h(jwt))
    assert resp.status_code == 403


def test_superadmin_is_refused(client):
    resp = client.get("/api/v2/owner/reports", headers=_h(login_superadmin(client)))
    assert resp.status_code == 403


def test_anonymous_is_401(client):
    assert client.get("/api/v2/owner/reports").status_code == 401
