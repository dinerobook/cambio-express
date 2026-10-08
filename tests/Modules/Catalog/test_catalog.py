"""Catalog module (P2-1): vendors + price-book items.

The invariants under test:
  * vendor names unique per store (case-insensitive),
  * item scan codes unique per store; search matches name substring
    OR scan-code prefix; list uses the shared pagination envelope,
  * department / vendor links validate store ownership; 0 clears an
    optional link on update,
  * cashiers (employees) can read the catalog but not manage it,
  * module flag bundles: price_book ON for cstore, OFF for msb_hybrid.
"""
from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


def _admin(client, test_store_id):
    return _headers(login_admin(client, test_store_id))


def _mk_vendor(client, h, name="Frio Distributing", **overrides):
    body = {"name": name}
    body.update(overrides)
    resp = client.post("/api/v2/catalog/vendors", headers=h, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["vendor"]


def _mk_item(client, h, pos_code="012345678905", name="Energy drink",
             **overrides):
    body = {"pos_code": pos_code, "name": name, "price": 2.99}
    body.update(overrides)
    resp = client.post("/api/v2/catalog/items", headers=h, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["item"]


# ── Vendors ────────────────────────────────────────────────


def test_vendor_crud_roundtrip(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(
        client, h, "Gulf Coast Wholesale",
        contact_name="Maria", phone="555-0100",
        account_number="AC-2231",
    )
    assert vendor["account_number"] == "AC-2231"

    resp = client.put(
        f"/api/v2/catalog/vendors/{vendor['id']}", headers=h,
        json={"phone": "555-0199", "is_active": False},
    )
    assert resp.status_code == 200
    assert resp.json()["vendor"]["phone"] == "555-0199"
    # Inactive vendors drop out of the default list.
    assert client.get(
        "/api/v2/catalog/vendors", headers=h,
    ).json()["vendors"] == []
    assert len(client.get(
        "/api/v2/catalog/vendors?include_inactive=1", headers=h,
    ).json()["vendors"]) == 1


def test_duplicate_vendor_name_conflicts(client, test_store_id):
    h = _admin(client, test_store_id)
    _mk_vendor(client, h, "Metro Foods")
    resp = client.post("/api/v2/catalog/vendors", headers=h, json={
        "name": "metro foods",
    })
    assert resp.status_code == 409


def test_vendor_item_count(client, test_store_id):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h, "Beverage Co")
    _mk_item(client, h, "111", "Cola", vendor_id=vendor["id"])
    _mk_item(client, h, "222", "Root beer", vendor_id=vendor["id"])
    rows = client.get(
        "/api/v2/catalog/vendors", headers=h,
    ).json()["vendors"]
    assert rows[0]["item_count"] == 2


# ── Items ──────────────────────────────────────────────────


def test_item_crud_and_search(client, test_store_id):
    h = _admin(client, test_store_id)
    _mk_item(client, h, "012345678905", "Monster Energy 16oz")
    _mk_item(client, h, "2", "7lb ice bag", pos_code_format="plu",
             price=2.99)

    # Name substring match.
    body = client.get(
        "/api/v2/catalog/items?q=energy", headers=h,
    ).json()
    assert body["total"] == 1
    assert body["rows"][0]["name"] == "Monster Energy 16oz"
    assert set(body) == {"rows", "total", "page", "total_pages"}

    # Scan-code prefix match.
    body = client.get("/api/v2/catalog/items?q=0123", headers=h).json()
    assert body["total"] == 1
    assert body["rows"][0]["pos_code"] == "012345678905"

    # Update price + deactivate; inactive drops from default list.
    item_id = body["rows"][0]["id"]
    resp = client.put(
        f"/api/v2/catalog/items/{item_id}", headers=h,
        json={"price": 3.49, "is_active": False},
    )
    assert resp.status_code == 200
    assert resp.json()["item"]["price"] == 3.49
    assert client.get(
        "/api/v2/catalog/items", headers=h,
    ).json()["total"] == 1  # only the ice bag remains active


def test_duplicate_pos_code_conflicts(client, test_store_id):
    h = _admin(client, test_store_id)
    _mk_item(client, h, "4900001", "Green tea")
    resp = client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "4900001", "name": "Different item",
    })
    assert resp.status_code == 409


def test_item_links_validate_and_clear(client, test_store_id):
    h = _admin(client, test_store_id)
    dept = client.post("/api/v2/dayclose/departments", headers=h, json={
        "name": "Beverages",
    }).json()["department"]
    vendor = _mk_vendor(client, h, "Beverage Co")
    item = _mk_item(
        client, h, "333", "Spring water",
        department_id=dept["id"], vendor_id=vendor["id"],
    )
    assert item["department_name"] == "Beverages"
    assert item["vendor_name"] == "Beverage Co"

    # A department id from another store's space 404s.
    resp = client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "444", "name": "Bad link", "department_id": 999999,
    })
    assert resp.status_code == 404

    # 0 clears an optional link on update.
    resp = client.put(
        f"/api/v2/catalog/items/{item['id']}", headers=h,
        json={"vendor_id": 0},
    )
    assert resp.status_code == 200
    assert resp.json()["item"]["vendor_id"] is None
    assert resp.json()["item"]["department_id"] == dept["id"]


def test_employee_reads_but_cannot_manage(client, test_store_id):
    h = _admin(client, test_store_id)
    _mk_item(client, h, "555", "Chips")
    emp, etok = make_employee_client(test_store_id)
    eh = _headers(etok)
    assert emp.get("/api/v2/catalog/items", headers=eh).status_code == 200
    assert emp.post("/api/v2/catalog/vendors", headers=eh, json={
        "name": "Nope Inc",
    }).status_code == 403
    assert emp.post("/api/v2/catalog/items", headers=eh, json={
        "pos_code": "666", "name": "Nope",
    }).status_code == 403


def test_price_book_bundle_by_business_type(client, test_store_id):
    from api.Modules.Billing.Services.feature_flags import (
        store_feature_enabled,
    )
    from api.Modules.Tenancy.Models import Store
    with db_session():
        store = db.session.get(Store, test_store_id)
        for btype, expected in (
            ("cstore", True), ("gas_station", True),
            ("grocery", True), ("msb_hybrid", False),
        ):
            store.business_type = btype
            assert store_feature_enabled(
                db.session, store, "module_price_book",
            ) is expected, btype


# ── Item-editor parity fields (P2-5 phase 1) ────────────────


def test_item_editor_fields_roundtrip(client, test_store_id):
    """item_number / size / case fields / EBT persist on create,
    PATCH individually, and clear via the 0 sentinel."""
    h = _admin(client, test_store_id)
    item = _mk_item(
        client, h, pos_code="345", name="ROOTS GINGER ( POUND )",
        item_number="4612", size="POUND",
        case_size=30, case_cost=45.00, is_ebt=True, cost=1.50,
    )
    assert item["item_number"] == "4612"
    assert item["size"] == "POUND"
    assert item["case_size"] == 30
    assert item["case_cost"] == 45.00
    assert item["is_ebt"] is True

    # Omitted fields stay put; sent fields change.
    patched = client.put(
        f"/api/v2/catalog/items/{item['id']}", headers=h,
        json={"size": "LB", "is_ebt": False},
    )
    assert patched.status_code == 200, patched.text
    row = patched.json()["item"]
    assert row["size"] == "LB"
    assert row["is_ebt"] is False
    assert row["item_number"] == "4612"
    assert row["case_size"] == 30

    # 0 clears the nullable case fields.
    cleared = client.put(
        f"/api/v2/catalog/items/{item['id']}", headers=h,
        json={"case_size": 0, "case_cost": 0},
    )
    assert cleared.status_code == 200
    row = cleared.json()["item"]
    assert row["case_size"] is None
    assert row["case_cost"] is None


def test_item_editor_fields_default_empty(client, test_store_id):
    """Items created without the new fields keep safe defaults —
    imports and old clients are unaffected."""
    h = _admin(client, test_store_id)
    item = _mk_item(client, h, pos_code="777", name="Plain item")
    assert item["item_number"] == ""
    assert item["size"] == ""
    assert item["case_size"] is None
    assert item["case_cost"] is None
    assert item["is_ebt"] is False


# ── Edge paths: validation, 404/409, cross-store, audit ────


def _other_store_rows():
    """A second store with a vendor, department and item of its own.
    Returns their ids."""
    from api.Modules.Catalog.Models import PriceBookItem, Vendor
    from api.Modules.DayClose.Models import Department
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other Shop", slug="other-shop")
        db.session.add(other)
        db.session.commit()
        vendor = Vendor(store_id=other.id, name="Foreign Vendor")
        dept = Department(store_id=other.id, name="Foreign Dept")
        db.session.add_all([vendor, dept])
        db.session.commit()
        item = PriceBookItem(
            store_id=other.id, pos_code="9999", name="Foreign item",
            vendor_id=vendor.id,
        )
        db.session.add(item)
        db.session.commit()
        return {
            "store": other.id, "vendor": vendor.id,
            "dept": dept.id, "item": item.id,
        }


def test_blank_vendor_name_is_refused(client, test_store_id):
    """Whitespace passes the schema's min_length but the service
    refuses it (create and rename)."""
    h = _admin(client, test_store_id)
    resp = client.post("/api/v2/catalog/vendors", headers=h,
                       json={"name": "   "})
    assert resp.status_code == 409
    assert "required" in resp.json()["detail"]
    vendor = _mk_vendor(client, h, "Real Vendor")
    resp = client.put(f"/api/v2/catalog/vendors/{vendor['id']}",
                      headers=h, json={"name": "  "})
    assert resp.status_code == 409


def test_vendor_update_rename_conflict_and_self_rename(
    client, test_store_id,
):
    h = _admin(client, test_store_id)
    _mk_vendor(client, h, "Alpha Foods")
    beta = _mk_vendor(client, h, "Beta Foods")
    url = f"/api/v2/catalog/vendors/{beta['id']}"
    # Taking another vendor's name (case-insensitive) conflicts.
    resp = client.put(url, headers=h, json={"name": "ALPHA foods"})
    assert resp.status_code == 409
    assert "already exists" in resp.json()["detail"]
    # Re-saving its own name (different case) is fine and trims.
    resp = client.put(url, headers=h, json={"name": " beta foods "})
    assert resp.status_code == 200
    assert resp.json()["vendor"]["name"] == "beta foods"


def test_vendor_update_unknown_and_other_store_is_404(
    client, test_store_id,
):
    h = _admin(client, test_store_id)
    other = _other_store_rows()
    for vid in (999999, other["vendor"]):
        resp = client.put(f"/api/v2/catalog/vendors/{vid}", headers=h,
                          json={"phone": "1"})
        assert resp.status_code == 404
    # The foreign vendor is untouched and invisible in the list.
    assert client.get("/api/v2/catalog/vendors",
                      headers=h).json()["vendors"] == []


def test_vendor_update_writes_audit_row(client, test_store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h, "Audited Co")
    client.put(f"/api/v2/catalog/vendors/{vendor['id']}", headers=h,
               json={"notes": "net 30"})
    with db_session():
        actions = {
            r.action for r in db.session.query(OperatorAuditLog)
            .filter_by(store_id=test_store_id).all()
        }
    assert {"create_vendor", "update_vendor"} <= actions


def test_catalog_requires_login(client):
    assert client.get("/api/v2/catalog/vendors").status_code == 401
    assert client.get("/api/v2/catalog/items").status_code == 401
    assert client.get("/api/v2/catalog/invoices").status_code == 401


def test_item_filters_by_department_and_vendor(client, test_store_id):
    h = _admin(client, test_store_id)
    dept = client.post("/api/v2/dayclose/departments", headers=h, json={
        "name": "Snacks",
    }).json()["department"]
    vendor = _mk_vendor(client, h, "Snack Co")
    _mk_item(client, h, "10", "Chips", department_id=dept["id"],
             vendor_id=vendor["id"])
    _mk_item(client, h, "11", "Loose item")
    by_dept = client.get(
        f"/api/v2/catalog/items?department_id={dept['id']}", headers=h,
    ).json()
    assert [r["name"] for r in by_dept["rows"]] == ["Chips"]
    by_vendor = client.get(
        f"/api/v2/catalog/items?vendor_id={vendor['id']}", headers=h,
    ).json()
    assert [r["name"] for r in by_vendor["rows"]] == ["Chips"]
    # include_inactive surfaces a deactivated item again.
    item_id = by_vendor["rows"][0]["id"]
    client.put(f"/api/v2/catalog/items/{item_id}", headers=h,
               json={"is_active": False})
    assert client.get(
        f"/api/v2/catalog/items?vendor_id={vendor['id']}", headers=h,
    ).json()["total"] == 0
    assert client.get(
        f"/api/v2/catalog/items?vendor_id={vendor['id']}"
        "&include_inactive=1", headers=h,
    ).json()["total"] == 1


def test_item_create_rejects_other_stores_links(client, test_store_id):
    """Department / vendor ids from another store look like they
    don't exist."""
    h = _admin(client, test_store_id)
    other = _other_store_rows()
    resp = client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "1", "name": "X", "department_id": other["dept"],
    })
    assert resp.status_code == 404
    resp = client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "2", "name": "X", "vendor_id": other["vendor"],
    })
    assert resp.status_code == 404
    assert client.get("/api/v2/catalog/items",
                      headers=h).json()["total"] == 0


def test_item_create_blank_scan_code_and_validation(client, test_store_id):
    h = _admin(client, test_store_id)
    resp = client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "  ", "name": "Blank code",
    })
    assert resp.status_code == 409
    assert "Scan code" in resp.json()["detail"]
    # Schema-level validation -> 422.
    for bad in (
        {"pos_code": "1", "name": "X", "price": -1},
        {"pos_code": "1", "name": "X", "pos_code_format": "ean"},
        {"pos_code": "1"},
    ):
        assert client.post("/api/v2/catalog/items", headers=h,
                           json=bad).status_code == 422


def test_item_update_scan_code_rules(client, test_store_id):
    h = _admin(client, test_store_id)
    a = _mk_item(client, h, "100", "Item A")
    b = _mk_item(client, h, "200", "Item B")
    url = f"/api/v2/catalog/items/{b['id']}"
    assert client.put(url, headers=h,
                      json={"pos_code": "100"}).status_code == 409
    assert client.put(url, headers=h,
                      json={"pos_code": "  "}).status_code == 409
    # Own code is not a conflict; it can also change to a free one.
    assert client.put(url, headers=h,
                      json={"pos_code": "200"}).status_code == 200
    resp = client.put(url, headers=h, json={
        "pos_code": "300", "pos_code_format": "plu",
        "name": "Item B2", "cost": 1.25, "is_taxable": False,
        "item_number": "N1",
    })
    assert resp.status_code == 200, resp.text
    row = resp.json()["item"]
    assert (row["pos_code"], row["pos_code_format"], row["name"]) == (
        "300", "plu", "Item B2",
    )
    assert row["cost"] == 1.25 and row["is_taxable"] is False
    assert row["item_number"] == "N1"
    assert client.get(f"/api/v2/catalog/items?q={a['pos_code']}",
                      headers=h).json()["total"] == 1


def test_item_update_unknown_and_other_store_is_404(client, test_store_id):
    h = _admin(client, test_store_id)
    other = _other_store_rows()
    for iid in (999999, other["item"]):
        resp = client.put(f"/api/v2/catalog/items/{iid}", headers=h,
                          json={"name": "Hijack"})
        assert resp.status_code == 404
    # Linking to another store's vendor/department on update is a 404.
    mine = _mk_item(client, h, "55", "Mine")
    for body in ({"vendor_id": other["vendor"]},
                 {"department_id": other["dept"]}):
        resp = client.put(f"/api/v2/catalog/items/{mine['id']}",
                          headers=h, json=body)
        assert resp.status_code == 404


def test_item_update_clears_department_with_zero(client, test_store_id):
    h = _admin(client, test_store_id)
    dept = client.post("/api/v2/dayclose/departments", headers=h, json={
        "name": "Dairy",
    }).json()["department"]
    item = _mk_item(client, h, "77", "Milk", department_id=dept["id"])
    resp = client.put(f"/api/v2/catalog/items/{item['id']}", headers=h,
                      json={"department_id": 0})
    assert resp.status_code == 200
    assert resp.json()["item"]["department_id"] is None


def test_employee_cannot_update_existing_catalog_rows(
    client, test_store_id,
):
    h = _admin(client, test_store_id)
    vendor = _mk_vendor(client, h, "Locked Vendor")
    item = _mk_item(client, h, "88", "Locked item")
    emp, etok = make_employee_client(test_store_id)
    eh = _headers(etok)
    assert emp.put(f"/api/v2/catalog/vendors/{vendor['id']}", headers=eh,
                   json={"phone": "1"}).status_code == 403
    assert emp.put(f"/api/v2/catalog/items/{item['id']}", headers=eh,
                   json={"price": 0}).status_code == 403
    assert emp.get("/api/v2/catalog/vendors", headers=eh).status_code == 200
    unchanged = client.get("/api/v2/catalog/items", headers=h).json()
    assert unchanged["rows"][0]["price"] == 2.99
