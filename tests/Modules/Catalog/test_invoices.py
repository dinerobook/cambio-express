"""Purchase invoices (P3-1): vendor invoices + price-book cost feedback.

The invariants under test:
  * invoice numbers unique per (store, vendor) — different vendors
    can reuse the same numbering,
  * total = subtotal + tax + other (derived, never stored),
  * line totals default to quantity × unit cost; a keyed printed
    amount wins,
  * update_item_costs pushes linked line costs onto the price book
    (and only then),
  * marking paid → un-paid clears paid_on; lines replace-all on
    update,
  * list filters by vendor / status / invoice-number search with
    the shared pagination envelope,
  * cashiers can read but not manage invoices.
"""
from tests.conftest import login_admin, make_employee_client


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


def _admin(client, test_store_id):
    return _headers(login_admin(client, test_store_id))


def _mk_vendor(client, h, name="Frio Distributing"):
    resp = client.post("/api/v2/catalog/vendors", headers=h, json={
        "name": name,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["vendor"]


def _mk_item(client, h, pos_code, name, cost=0.0):
    resp = client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": pos_code, "name": name, "price": 2.99, "cost": cost,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["item"]


def test_invoice_create_totals_and_line_math(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    item = _mk_item(client, h, "111", "Cola 20oz")

    resp = client.post("/api/v2/catalog/invoices", headers=h, json={
        "vendor_id": vendor["id"],
        "invoice_number": "INV-1001",
        "invoice_date": "2026-08-20",
        "due_date": "2026-09-05",
        "subtotal": 480.00,
        "tax": 12.40,
        "other": 7.60,
        "lines": [
            # Derived line total: 24 × $1.10 = $26.40.
            {"item_id": item["id"], "quantity": 24, "unit_cost": 1.10},
            # Keyed printed amount wins over 10 × $2.00.
            {"description": "CO2 tank refill", "quantity": 10,
             "unit_cost": 2.00, "line_total": 19.75},
        ],
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    inv = body["invoice"]
    assert inv["vendor_name"] == "Frio Distributing"
    assert inv["total"] == 500.00          # 480 + 12.40 + 7.60
    assert inv["line_count"] == 2
    lines = {
        (line["item_id"], line["description"]): line
        for line in inv["lines"]
    }
    assert lines[(item["id"], "")]["line_total"] == 26.40
    assert lines[(None, "CO2 tank refill")]["line_total"] == 19.75
    assert lines[(item["id"], "")]["item_name"] == "Cola 20oz"
    # No cost feedback unless asked for.
    assert body["items_cost_updated"] == 0
    assert client.get(
        f"/api/v2/catalog/items?q=111", headers=h,
    ).json()["rows"][0]["cost"] == 0.0


def test_invoice_number_unique_per_vendor(client, test_store_id):
    h = _admin(client, test_store_id)
    v1 = _mk_vendor(client, h, "Vendor A")
    v2 = _mk_vendor(client, h, "Vendor B")
    base = {"invoice_number": "1000", "invoice_date": "2026-08-20"}
    assert client.post("/api/v2/catalog/invoices", headers=h, json={
        **base, "vendor_id": v1["id"],
    }).status_code == 201
    # Same number at the same vendor conflicts…
    assert client.post("/api/v2/catalog/invoices", headers=h, json={
        **base, "vendor_id": v1["id"],
    }).status_code == 409
    # …but a different vendor can reuse it.
    assert client.post("/api/v2/catalog/invoices", headers=h, json={
        **base, "vendor_id": v2["id"],
    }).status_code == 201


def test_update_item_costs_feedback(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    item = _mk_item(client, h, "222", "Chips", cost=0.80)
    resp = client.post("/api/v2/catalog/invoices", headers=h, json={
        "vendor_id": vendor["id"],
        "invoice_number": "INV-2",
        "invoice_date": "2026-08-21",
        "lines": [
            {"item_id": item["id"], "quantity": 12, "unit_cost": 0.95},
        ],
        "update_item_costs": True,
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["items_cost_updated"] == 1
    assert client.get(
        "/api/v2/catalog/items?q=222", headers=h,
    ).json()["rows"][0]["cost"] == 0.95


def test_invoice_update_status_and_lines(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    inv = client.post("/api/v2/catalog/invoices", headers=h, json={
        "vendor_id": vendor["id"],
        "invoice_number": "INV-3",
        "invoice_date": "2026-08-21",
        "subtotal": 100.0,
        "lines": [{"description": "Old line", "quantity": 1,
                   "unit_cost": 100.0}],
    }).json()["invoice"]

    # Mark paid.
    resp = client.put(
        f"/api/v2/catalog/invoices/{inv['id']}", headers=h,
        json={"status": "paid", "paid_on": "2026-08-25"},
    )
    assert resp.status_code == 200
    assert resp.json()["invoice"]["paid_on"] == "2026-08-25"

    # Reopen clears paid_on; lines replace-all.
    resp = client.put(
        f"/api/v2/catalog/invoices/{inv['id']}", headers=h,
        json={
            "status": "open",
            "lines": [
                {"description": "New line", "quantity": 2,
                 "unit_cost": 40.0},
            ],
        },
    )
    body = resp.json()["invoice"]
    assert body["paid_on"] is None
    assert [line["description"] for line in body["lines"]] == ["New line"]
    assert body["lines"][0]["line_total"] == 80.0


def test_invoice_list_filters_and_delete(client, test_store_id):
    h = _admin(client, test_store_id)
    v1 = _mk_vendor(client, h, "Vendor A")
    v2 = _mk_vendor(client, h, "Vendor B")
    for vendor, number, status in (
        (v1, "A-1", "open"), (v1, "A-2", "paid"), (v2, "B-9", "open"),
    ):
        assert client.post("/api/v2/catalog/invoices", headers=h, json={
            "vendor_id": vendor["id"], "invoice_number": number,
            "invoice_date": "2026-08-22", "status": status,
            "paid_on": "2026-08-22" if status == "paid" else None,
        }).status_code == 201

    body = client.get(
        f"/api/v2/catalog/invoices?vendor_id={v1['id']}", headers=h,
    ).json()
    assert body["total"] == 2
    assert set(body) == {"rows", "total", "page", "total_pages"}
    assert client.get(
        "/api/v2/catalog/invoices?status=paid", headers=h,
    ).json()["total"] == 1
    assert client.get(
        "/api/v2/catalog/invoices?q=B-", headers=h,
    ).json()["total"] == 1

    target = body["rows"][0]["id"]
    assert client.delete(
        f"/api/v2/catalog/invoices/{target}", headers=h,
    ).status_code == 200
    assert client.get(
        f"/api/v2/catalog/invoices/{target}", headers=h,
    ).status_code == 404


def test_employee_reads_but_cannot_manage_invoices(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    emp, etok = make_employee_client(test_store_id)
    eh = _headers(etok)
    assert emp.get(
        "/api/v2/catalog/invoices", headers=eh,
    ).status_code == 200
    assert emp.post("/api/v2/catalog/invoices", headers=eh, json={
        "vendor_id": vendor["id"], "invoice_number": "NOPE",
        "invoice_date": "2026-08-22",
    }).status_code == 403


# ── Edge paths: validation, 404/409, cross-store ───────────


def _mk_invoice(client, h, vendor_id, number="INV-X", **overrides):
    body = {
        "vendor_id": vendor_id, "invoice_number": number,
        "invoice_date": "2026-08-20", "subtotal": 10.0,
    }
    body.update(overrides)
    resp = client.post("/api/v2/catalog/invoices", headers=h, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["invoice"]


def _foreign_vendor_and_item():
    from api.Modules.Catalog.Models import PriceBookItem, Vendor
    from api.Modules.Tenancy.Models import Store
    from tests._app import db, db_session
    with db_session():
        other = Store(name="Other Shop", slug="other-shop")
        db.session.add(other)
        db.session.commit()
        vendor = Vendor(store_id=other.id, name="Foreign Vendor")
        db.session.add(vendor)
        db.session.commit()
        item = PriceBookItem(
            store_id=other.id, pos_code="9", name="Foreign item",
            cost_cents=100,
        )
        db.session.add(item)
        db.session.commit()
        return vendor.id, item.id


def test_invoice_create_rejects_unknown_and_other_store_refs(
    client, test_store_id,
):
    h = _admin(client, test_store_id)
    foreign_vendor, foreign_item = _foreign_vendor_and_item()
    base = {"invoice_number": "INV-1", "invoice_date": "2026-08-20"}
    for vid in (999999, foreign_vendor):
        resp = client.post("/api/v2/catalog/invoices", headers=h,
                           json={**base, "vendor_id": vid})
        assert resp.status_code == 404
    vendor = _mk_vendor(client, h)
    resp = client.post("/api/v2/catalog/invoices", headers=h, json={
        **base, "vendor_id": vendor["id"],
        "lines": [{"item_id": foreign_item, "unit_cost": 5}],
    })
    assert resp.status_code == 404
    # Nothing was half-created.
    assert client.get("/api/v2/catalog/invoices",
                      headers=h).json()["total"] == 0


def test_invoice_create_validation_errors(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    base = {"vendor_id": vendor["id"], "invoice_number": "INV-V",
            "invoice_date": "2026-08-20"}
    # Blank number passes min_length but the service refuses -> 409.
    resp = client.post("/api/v2/catalog/invoices", headers=h,
                       json={**base, "invoice_number": "   "})
    assert resp.status_code == 409
    # Bad date shapes -> 422 naming the field.
    for field, value in (("invoice_date", "08/20/2026"),
                         ("due_date", "2026-13-45"),
                         ("paid_on", "not-a-date")):
        resp = client.post("/api/v2/catalog/invoices", headers=h,
                           json={**base, field: value})
        assert resp.status_code == 422
        assert resp.json()["detail"]["field"] == field
    # Schema-level: unknown status, negative money.
    assert client.post("/api/v2/catalog/invoices", headers=h,
                       json={**base, "status": "void"}).status_code == 422
    assert client.post("/api/v2/catalog/invoices", headers=h,
                       json={**base, "tax": -1}).status_code == 422


def test_invoice_get_detail_and_404s(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    item = _mk_item(client, h, "30", "Soda")
    inv = _mk_invoice(client, h, vendor["id"], "INV-D", due_date="2026-09-01",
                      lines=[{"item_id": item["id"], "quantity": 3,
                              "unit_cost": 2.0}])
    resp = client.get(f"/api/v2/catalog/invoices/{inv['id']}", headers=h)
    assert resp.status_code == 200
    body = resp.json()["invoice"]
    assert body["vendor_name"] == vendor["name"]
    assert body["due_date"] == "2026-09-01"
    assert body["lines"][0]["item_name"] == "Soda"
    assert body["lines"][0]["line_total"] == 6.0
    assert client.get("/api/v2/catalog/invoices/999999",
                      headers=h).status_code == 404


def test_invoice_other_store_is_404_on_read_update_delete(
    client, test_store_id,
):
    from api.Modules.Catalog.Models import PurchaseInvoice
    from datetime import date
    from tests._app import db, db_session
    h = _admin(client, test_store_id)
    foreign_vendor, _ = _foreign_vendor_and_item()
    with db_session():
        from api.Modules.Catalog.Models import Vendor
        store_id = db.session.get(Vendor, foreign_vendor).store_id
        inv = PurchaseInvoice(
            store_id=store_id, vendor_id=foreign_vendor,
            invoice_number="F-1", invoice_date=date(2026, 1, 1),
        )
        db.session.add(inv)
        db.session.commit()
        iid = inv.id
    url = f"/api/v2/catalog/invoices/{iid}"
    assert client.get(url, headers=h).status_code == 404
    assert client.put(url, headers=h,
                      json={"notes": "x"}).status_code == 404
    assert client.delete(url, headers=h).status_code == 404
    with db_session():
        assert db.session.get(PurchaseInvoice, iid) is not None


def test_invoice_update_validation_and_conflicts(client, test_store_id):
    h = _admin(client, test_store_id)
    v1 = _mk_vendor(client, h, "Vendor One")
    v2 = _mk_vendor(client, h, "Vendor Two")
    _mk_invoice(client, h, v1["id"], "A-1")
    b = _mk_invoice(client, h, v1["id"], "B-1")
    url = f"/api/v2/catalog/invoices/{b['id']}"
    assert client.put(url, headers=h,
                      json={"invoice_number": "A-1"}).status_code == 409
    assert client.put(url, headers=h,
                      json={"invoice_number": "  "}).status_code == 409
    # Same number is fine once the invoice moves to a vendor that
    # does not have it.
    resp = client.put(url, headers=h, json={"vendor_id": v2["id"],
                                            "invoice_number": "A-1"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["invoice"]["vendor_name"] == "Vendor Two"
    assert client.put(url, headers=h,
                      json={"vendor_id": 999999}).status_code == 404
    assert client.put(url, headers=h,
                      json={"invoice_date": "bad-date!!"}).status_code == 422
    assert client.put(url, headers=h,
                      json={"status": "void"}).status_code == 422
    assert client.put("/api/v2/catalog/invoices/999999", headers=h,
                      json={"notes": "x"}).status_code == 404


def test_invoice_update_fields_dates_and_money(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    inv = _mk_invoice(client, h, vendor["id"], "INV-U",
                      due_date="2026-09-01")
    url = f"/api/v2/catalog/invoices/{inv['id']}"
    resp = client.put(url, headers=h, json={
        "invoice_date": "2026-08-01", "subtotal": 100.0, "tax": 8.25,
        "other": 1.75, "notes": " fuel surcharge ",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()["invoice"]
    assert body["invoice_date"] == "2026-08-01"
    assert body["total"] == 110.0           # subtotal + tax + other
    assert body["notes"] == "fuel surcharge"
    # Omitting due_date leaves it; clear_due_date removes it.
    assert body["due_date"] == "2026-09-01"
    resp = client.put(url, headers=h, json={"due_date": "2026-09-15"})
    assert resp.json()["invoice"]["due_date"] == "2026-09-15"
    resp = client.put(url, headers=h, json={"clear_due_date": True})
    assert resp.json()["invoice"]["due_date"] is None


def test_invoice_update_item_costs_applies_and_validates_lines(
    client, test_store_id,
):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    item = _mk_item(client, h, "40", "Juice", cost=1.0)
    inv = _mk_invoice(client, h, vendor["id"], "INV-C")
    url = f"/api/v2/catalog/invoices/{inv['id']}"
    resp = client.put(url, headers=h, json={
        "lines": [{"item_id": item["id"], "quantity": 2,
                   "unit_cost": 1.5}],
        "update_item_costs": True,
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["items_cost_updated"] == 1
    items = client.get("/api/v2/catalog/items", headers=h).json()["rows"]
    assert items[0]["cost"] == 1.5
    # A line pointing at a missing item is refused, invoice intact.
    resp = client.put(url, headers=h, json={
        "lines": [{"item_id": 999999, "unit_cost": 1}],
    })
    assert resp.status_code == 404
    got = client.get(url, headers=h).json()["invoice"]
    assert got["line_count"] == 1


def test_invoice_line_total_keyed_amount_wins_and_unlinked_cost_skipped(
    client, test_store_id,
):
    """update_item_costs ignores free-text lines and zero-cost lines;
    a keyed line_total beats quantity x unit cost."""
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    item = _mk_item(client, h, "50", "Gum", cost=0.5)
    resp = client.post("/api/v2/catalog/invoices", headers=h, json={
        "vendor_id": vendor["id"], "invoice_number": "INV-K",
        "invoice_date": "2026-08-20", "update_item_costs": True,
        "lines": [
            {"description": "Freight", "quantity": 1, "unit_cost": 9.0,
             "line_total": 9.5},
            {"item_id": item["id"], "unit_cost": 0},
        ],
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["items_cost_updated"] == 0
    lines = resp.json()["invoice"]["lines"]
    assert lines[0]["line_total"] == 9.5
    items = client.get("/api/v2/catalog/items", headers=h).json()["rows"]
    assert items[0]["cost"] == 0.5


def test_invoice_create_with_unknown_status_in_service_is_refused(
    client, test_store_id,
):
    """The service re-checks status even if a caller bypasses the
    request schema."""
    import pytest
    from api.Core.Database import SessionLocal
    from api.Modules.Catalog.Services import (
        CatalogConflictError, create_invoice, update_invoice,
    )
    from datetime import date
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    db_ = SessionLocal()
    try:
        with pytest.raises(CatalogConflictError):
            create_invoice(db_, test_store_id, {
                "vendor_id": vendor["id"], "invoice_number": "S-1",
                "invoice_date": date(2026, 1, 1), "status": "void",
            }, created_by=None)
        inv = _mk_invoice(client, h, vendor["id"], "S-2")
        with pytest.raises(CatalogConflictError):
            update_invoice(db_, test_store_id, inv["id"],
                           {"status": "void"})
    finally:
        db_.rollback()
        db_.close()


def test_invoice_list_status_filter_and_bad_status(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    _mk_invoice(client, h, vendor["id"], "OPEN-1")
    _mk_invoice(client, h, vendor["id"], "PAID-1", status="paid",
                paid_on="2026-08-21")
    rows = client.get("/api/v2/catalog/invoices?status=paid",
                      headers=h).json()["rows"]
    assert [r["invoice_number"] for r in rows] == ["PAID-1"]
    assert client.get("/api/v2/catalog/invoices?status=void",
                      headers=h).status_code == 422


def test_employee_cannot_update_or_delete_invoices(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h)
    inv = _mk_invoice(client, h, vendor["id"], "INV-E")
    emp, etok = make_employee_client(test_store_id)
    eh = _headers(etok)
    url = f"/api/v2/catalog/invoices/{inv['id']}"
    assert emp.put(url, headers=eh, json={"notes": "x"}).status_code == 403
    assert emp.delete(url, headers=eh).status_code == 403
    assert client.get(url, headers=h).status_code == 200
