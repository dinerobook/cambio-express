"""CSV export dispatcher — scope authorization, input parsing, rows.

Covers `api/Modules/Reports/Controllers/csv_export.py`: the store-scope
`/api/v2/reports/{slug}.csv` route and the platform-scope
`/api/v2/superadmin/reports/{slug}.csv` route. Per-report row math is
covered by the service tests; this file pins the access rules
(grant / deny / cross-store), the 404 / 422 paths and the transfers
dump's money identity (invariant #9).
"""
import csv
import io
from datetime import date

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_owner, login_superadmin

D1 = date(2026, 8, 10)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _rows(text):
    return list(csv.reader(io.StringIO(text)))


def _make_other_store(slug="other-csv"):
    from api.Modules.Tenancy.Models import Store
    s = Store(name=slug, slug=slug, email=f"{slug}@x.com", plan="basic")
    db.session.add(s)
    db.session.commit()
    return s.id


def _make_owner(store_ids, username="csv-owner@x.com"):
    from api.Modules.Tenancy.Models import StoreOwnerLink, User
    u = User(store_id=None, username=username, full_name="Owner",
             email=username, role="owner")
    u.set_password("ownerpass123")
    db.session.add(u)
    db.session.commit()
    for sid in store_ids:
        db.session.add(StoreOwnerLink(owner_id=u.id, store_id=sid))
    db.session.commit()
    return username


def _add_transfer(store_id, *, send_amount, fee, federal_tax,
                  sender="Ana"):
    from api.Modules.Transfers.Models import Transfer
    t = Transfer(
        store_id=store_id, send_date=D1, company="Intermex",
        service_type="Money Transfer", sender_name=sender,
        recipient_name="Rec", country="MX", confirm_number=f"C-{sender}",
        send_amount=send_amount, fee=fee, federal_tax=federal_tax,
        commission=0.0, status="Sent",
    )
    db.session.add(t)
    db.session.commit()
    return t.id


# ── transfers dump: rows, money identity, download headers ──


def test_transfers_csv_rows_totals_and_money_identity(client, test_store_id):
    with db_session():
        _add_transfer(test_store_id, send_amount=500.0, fee=5.0,
                      federal_tax=5.0)
    h = _h(login_admin(client, test_store_id))
    resp = client.get(
        f"/api/v2/reports/transfers.csv?from=2026-08-01&to=2026-08-31"
        f"&store_ids={test_store_id}", headers=h,
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert "transfers_2026-08-01_2026-08-31.csv" in (
        resp.headers["content-disposition"])
    rows = _rows(resp.text)
    data = [r for r in rows[1:] if r and r[0] == "2026-08-10"]
    assert len(data) == 1
    send, fee, tax, total = (float(x) for x in data[0][6:10])
    assert total == send + fee + tax == 510.0
    totals = next(r for r in rows if r and r[0] == "TOTAL")
    assert totals[5] == "1" and float(totals[6]) == 500.0


def test_transfers_csv_excludes_rows_outside_window(client, test_store_id):
    with db_session():
        _add_transfer(test_store_id, send_amount=100.0, fee=1.0,
                      federal_tax=1.0)
    h = _h(login_admin(client, test_store_id))
    resp = client.get(
        "/api/v2/reports/transfers.csv?from=2026-09-01&to=2026-09-30",
        headers=h,
    )
    rows = _rows(resp.text)
    assert not any(r and r[0] == "2026-08-10" for r in rows)
    assert next(r for r in rows if r and r[0] == "TOTAL")[5] == "0"


def test_swapped_and_garbage_dates_are_tolerated(client, test_store_id):
    with db_session():
        _add_transfer(test_store_id, send_amount=100.0, fee=1.0,
                      federal_tax=1.0)
    h = _h(login_admin(client, test_store_id))
    # from > to is swapped, so the row is still found.
    swapped = client.get(
        "/api/v2/reports/transfers.csv?from=2026-08-31&to=2026-08-01",
        headers=h,
    )
    assert swapped.status_code == 200
    assert any(r and r[0] == "2026-08-10" for r in _rows(swapped.text))
    assert "transfers_2026-08-01_2026-08-31.csv" in (
        swapped.headers["content-disposition"])
    # Unparseable dates fall back to the current month, not an error.
    junk = client.get(
        "/api/v2/reports/transfers.csv?from=nope&to=also-nope", headers=h,
    )
    assert junk.status_code == 200
    assert junk.headers["content-disposition"].startswith("attachment")


# ── scope authorization: deny paths ─────────────────────────


def test_csv_requires_auth(client):
    resp = client.get("/api/v2/reports/transfers.csv")
    assert resp.status_code == 401


def test_unknown_store_slug_is_404(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    resp = client.get("/api/v2/reports/no-such-report.csv", headers=h)
    assert resp.status_code == 404


def test_malformed_store_ids_is_422(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    resp = client.get(
        "/api/v2/reports/transfers.csv?store_ids=1,abc", headers=h,
    )
    assert resp.status_code == 422


def test_admin_cannot_export_another_stores_data(client, test_store_id):
    with db_session():
        other = _make_other_store()
        _add_transfer(other, send_amount=999.0, fee=9.0, federal_tax=9.0,
                      sender="Hidden")
    h = _h(login_admin(client, test_store_id))
    resp = client.get(
        f"/api/v2/reports/transfers.csv?store_ids={other}"
        "&from=2026-08-01&to=2026-08-31", headers=h,
    )
    assert resp.status_code == 403
    assert "Hidden" not in resp.text
    # Mixing own + foreign id is refused too, not silently narrowed.
    mixed = client.get(
        f"/api/v2/reports/transfers.csv?store_ids={test_store_id},{other}",
        headers=h,
    )
    assert mixed.status_code == 403


def test_superadmin_store_report_needs_explicit_store_ids(client):
    h = _h(login_superadmin(client))
    resp = client.get("/api/v2/reports/transfers.csv", headers=h)
    assert resp.status_code == 422


def test_superadmin_can_export_any_store(client, test_store_id):
    with db_session():
        _add_transfer(test_store_id, send_amount=250.0, fee=2.0,
                      federal_tax=2.5, sender="SAView")
    h = _h(login_superadmin(client))
    resp = client.get(
        f"/api/v2/reports/transfers.csv?store_ids={test_store_id}"
        "&from=2026-08-01&to=2026-08-31", headers=h,
    )
    assert resp.status_code == 200
    assert "SAView" in resp.text


# ── owner umbrella ──────────────────────────────────────────


def test_owner_empty_store_ids_resolves_to_umbrella(client, test_store_id):
    with db_session():
        other = _make_other_store()
        username = _make_owner([test_store_id, other])
        _add_transfer(test_store_id, send_amount=100.0, fee=1.0,
                      federal_tax=1.0, sender="HomeSend")
        _add_transfer(other, send_amount=200.0, fee=2.0, federal_tax=2.0,
                      sender="SiblingSend")
    h = _h(login_owner(client, username))
    resp = client.get(
        "/api/v2/reports/transfers.csv?from=2026-08-01&to=2026-08-31",
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    assert "HomeSend" in resp.text and "SiblingSend" in resp.text


def test_owner_outside_umbrella_is_403_and_partial_is_narrowed(
    client, test_store_id,
):
    with db_session():
        mine = _make_other_store("mine-csv")
        stranger = _make_other_store("stranger-csv")
        username = _make_owner([mine])
        _add_transfer(stranger, send_amount=300.0, fee=3.0,
                      federal_tax=3.0, sender="Stranger")
    h = _h(login_owner(client, username))
    denied = client.get(
        f"/api/v2/reports/transfers.csv?store_ids={stranger}"
        "&from=2026-08-01&to=2026-08-31", headers=h,
    )
    assert denied.status_code == 403
    narrowed = client.get(
        f"/api/v2/reports/transfers.csv?store_ids={mine},{stranger}"
        "&from=2026-08-01&to=2026-08-31", headers=h,
    )
    assert narrowed.status_code == 200
    assert "Stranger" not in narrowed.text


# ── threshold parsing (high-value-transfers) ────────────────


@pytest.mark.parametrize("threshold,expect_big,expect_small", [
    (None, True, False),        # default 1000 is not hit by 600
    ("abc", True, False),       # garbage falls back to the default
    ("500", True, True),
    ("-5", True, True),         # negative clamps to 0
])
def test_high_value_threshold_parsing(
    client, test_store_id, threshold, expect_big, expect_small,
):
    with db_session():
        _add_transfer(test_store_id, send_amount=2000.0, fee=5.0,
                      federal_tax=20.0, sender="Big")
        _add_transfer(test_store_id, send_amount=600.0, fee=5.0,
                      federal_tax=6.0, sender="Small")
    h = _h(login_admin(client, test_store_id))
    q = "from=2026-08-01&to=2026-08-31"
    if threshold is not None:
        q += f"&threshold={threshold}"
    resp = client.get(f"/api/v2/reports/high-value-transfers.csv?{q}",
                      headers=h)
    assert resp.status_code == 200, resp.text
    assert ("Big" in resp.text) is expect_big
    assert ("Small" in resp.text) is expect_small


# ── superadmin platform-scope route ─────────────────────────


def test_superadmin_csv_denied_to_store_admin(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    resp = client.get(
        "/api/v2/superadmin/reports/active-stores-by-plan.csv", headers=h,
    )
    assert resp.status_code == 403


def test_superadmin_csv_unknown_slug_404_and_known_ok(client):
    h = _h(login_superadmin(client))
    assert client.get(
        "/api/v2/superadmin/reports/nope.csv", headers=h,
    ).status_code == 404
    resp = client.get(
        "/api/v2/superadmin/reports/active-stores-by-plan.csv", headers=h,
    )
    assert resp.status_code == 200
    rows = _rows(resp.text)
    assert rows[0] == ["Plan", "Stores"]
    assert any(r and r[0] == "TOTAL" for r in rows)
