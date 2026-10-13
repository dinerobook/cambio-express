"""Every route that takes a store id from the client keeps the caller
inside their own stores.

A route reading ``store_id`` / ``store_ids`` from the URL or query
string used to trust it: an admin at store B could read store A's
customers, transfers, daily book and reports, and overwrite store A's
customer records, by editing the number. ``api.Core.StoreScope`` is
the one check; the walk below fails when a route that takes a store
id answers another tenant.

Superadmin-only surfaces (``/superadmin/*``, ``/feature-flags/*``,
``/tickets/all``) are platform scope by design and are covered by the
superadmin route contract test instead.
"""
from __future__ import annotations

import re
from datetime import date

import pytest
from fastapi.routing import APIRoute

from tests._app import db, db_session
from tests.conftest import login_admin, login_owner, login_superadmin

D = date(2026, 10, 1)

PLATFORM_PREFIXES = ("/superadmin/", "/feature-flags/", "/tickets/all")
SCOPE_PARAMS = {"store_id", "store_ids"}


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _params(dep) -> list[str]:
    out = [p.name for p in dep.query_params + dep.path_params]
    for sub in dep.dependencies:
        out += _params(sub)
    return out


def _client_scoped_routes() -> list[tuple[str, str]]:
    from api.main import create_app

    found = []
    for r in create_app().routes:
        if not isinstance(r, APIRoute):
            continue
        if r.path.startswith(PLATFORM_PREFIXES):
            continue
        if SCOPE_PARAMS & set(_params(r.dependant)):
            for m in sorted(r.methods - {"HEAD", "OPTIONS"}):
                found.append((m, r.path))
    return found


ROUTES = _client_scoped_routes()


def _other_store_admin(client) -> tuple[int, dict[str, str]]:
    from api.Modules.Tenancy.Models import Store, User

    with db_session():
        s = Store(name="Other", slug="scope-other", email="o@x.com",
                  plan="basic")
        db.session.add(s)
        db.session.flush()
        u = User(store_id=s.id, username="admin-other@x.com",
                 full_name="Other admin", role="admin")
        u.set_password("testpass123!")
        db.session.add(u)
        db.session.commit()
        sid = s.id
    return sid, _h(login_admin(client, sid))


def _seed_store_a(store_id: int, admin_id: int) -> int:
    """Rows a leak would expose: a customer, a transfer, a day."""
    from api.Modules.Customers.Models import Customer
    from api.Modules.DailyBook.Models import DailyReport
    from tests.conftest import seed_transfer

    with db_session():
        c = Customer(store_id=store_id, full_name="Maria Privada",
                     phone_country="+1", phone_number="5551234567")
        db.session.add(c)
        db.session.add(DailyReport(store_id=store_id, report_date=D,
                                   taxable_sales=1234.0))
        db.session.commit()
        cid = c.id
    seed_transfer(store_id, admin_id, sender_name="Maria Privada",
                  send_amount=777.0)
    return cid


def _fill(path: str, store_id: int, cid: int) -> str:
    path = path.replace("{store_id}", str(store_id))
    path = path.replace("{report_date}", D.isoformat())
    path = path.replace("{customer_id}", str(cid))
    path = path.replace("{slug}", "transfers")
    return re.sub(r"\{[^}]+\}", "1", path)


def test_walk_finds_the_known_client_scoped_routes():
    paths = {p for _, p in ROUTES}
    for expected in (
        "/customers/search", "/customers/{customer_id}",
        "/transfers", "/transfers/{transfer_id}",
        "/daily/{store_id}/{report_date}", "/daily/{store_id}/period",
        "/reports/sales-by-company", "/reports/{slug}.csv",
    ):
        assert expected in paths, expected


@pytest.mark.parametrize("method,path", ROUTES)
def test_other_store_admin_is_refused(method, path, client, test_store_id,
                                      test_admin_id):
    cid = _seed_store_a(test_store_id, test_admin_id)
    _, hb = _other_store_admin(client)
    url = "/api/v2" + _fill(path, test_store_id, cid)
    sep = "&" if "?" in url else "?"
    url += (f"{sep}store_id={test_store_id}&store_ids={test_store_id}"
            f"&from=2026-10-01&to=2026-10-02&q=Maria")
    kwargs = {"headers": hb}
    if method in ("POST", "PUT", "PATCH"):
        kwargs["json"] = {
            "full_name": "Hacked", "phone_country": "+1",
            "phone_number": "5551234567",
        }
    resp = getattr(client, method.lower())(url, **kwargs)
    assert resp.status_code in (403, 404, 405, 409, 422), (
        method, path, resp.status_code, resp.get_data(as_text=True)[:200],
    )
    assert "Maria Privada" not in resp.get_data(as_text=True)


def test_customer_upsert_cannot_rename_another_stores_customer(
    client, test_store_id, test_admin_id,
):
    from api.Modules.Customers.Models import Customer

    cid = _seed_store_a(test_store_id, test_admin_id)
    _, hb = _other_store_admin(client)
    r = client.post(
        f"/api/v2/customers/upsert?store_id={test_store_id}", headers=hb,
        json={"full_name": "Hacked Name", "phone_country": "+1",
              "phone_number": "5551234567"},
    )
    assert r.status_code == 403
    with db_session():
        assert db.session.get(Customer, cid).full_name == "Maria Privada"


def test_own_store_still_reads_and_writes(client, test_store_id,
                                          test_admin_id):
    cid = _seed_store_a(test_store_id, test_admin_id)
    h = _h(login_admin(client, test_store_id))
    sid = test_store_id
    assert client.get(
        f"/api/v2/customers/search?store_id={sid}&q=Maria", headers=h,
    ).get_json()["matches"][0]["full_name"] == "Maria Privada"
    assert client.get(f"/api/v2/customers/{cid}?store_id={sid}",
                      headers=h).status_code == 200
    assert client.get(f"/api/v2/transfers?store_ids={sid}",
                      headers=h).get_json()["total"] == 1
    assert client.get(f"/api/v2/daily/{sid}/{D.isoformat()}",
                      headers=h).status_code == 200
    assert client.get(
        f"/api/v2/daily/{sid}/period?from=2026-10-01&to=2026-10-02",
        headers=h,
    ).status_code == 200
    r = client.get(
        f"/api/v2/reports/sales-by-company?store_ids={sid}"
        f"&from=2026-01-01&to=2026-12-31", headers=h,
    )
    assert r.status_code == 200
    r = client.post(
        f"/api/v2/customers/upsert?store_id={sid}", headers=h,
        json={"full_name": "Maria Nueva", "phone_country": "+1",
              "phone_number": "5551234567"},
    )
    assert r.status_code == 200
    assert r.get_json()["customer"]["id"] == cid


def test_owner_reads_inside_umbrella_only(client, test_store_id,
                                          test_admin_id):
    from api.Modules.Tenancy.Models import StoreOwnerLink, User

    _seed_store_a(test_store_id, test_admin_id)
    other_sid, _ = _other_store_admin(client)
    with db_session():
        u = User(store_id=None, username="scope-owner@x.com",
                 email="scope-owner@x.com", full_name="Owner",
                 role="owner")
        u.set_password("ownerpass123")
        db.session.add(u)
        db.session.flush()
        db.session.add(StoreOwnerLink(owner_id=u.id, store_id=other_sid))
        db.session.commit()
    h = _h(login_owner(client, "scope-owner@x.com"))
    # Their own store answers.
    assert client.get(f"/api/v2/transfers?store_ids={other_sid}",
                      headers=h).status_code == 200
    # Someone else's store does not.
    for url in (
        f"/api/v2/transfers?store_ids={test_store_id}",
        f"/api/v2/reports/top-customers?store_ids={test_store_id}",
        f"/api/v2/customers/search?store_id={test_store_id}&q=Maria",
        f"/api/v2/daily/{test_store_id}/{D.isoformat()}",
    ):
        r = client.get(url, headers=h)
        assert r.status_code == 403, (url, r.status_code)
    # A mixed list keeps only the owner's store.
    r = client.get(
        f"/api/v2/transfers?store_ids={test_store_id},{other_sid}",
        headers=h,
    )
    assert r.status_code == 200
    assert r.get_json()["total"] == 0


def test_superadmin_keeps_platform_reads(client, test_store_id,
                                         test_admin_id):
    _seed_store_a(test_store_id, test_admin_id)
    h = _h(login_superadmin(client))
    assert client.get(f"/api/v2/transfers?store_ids={test_store_id}",
                      headers=h).status_code == 200
    assert client.get(
        f"/api/v2/reports/sales-by-company?store_ids={test_store_id}",
        headers=h,
    ).status_code == 200
