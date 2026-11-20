"""Universal product catalog, scan lookup and the Modisoft import.

Invariants under test:
  * scan codes reduce to one GTIN-14 per product; PLUs, in-store
    numbers, bad check digits and letters stay store codes (never
    shared),
  * the first store to bring a GTIN names the shared product; later
    stores never overwrite it, and nothing about another store's item
    (price, cost, name) comes back from a lookup,
  * the lookup is read-only (invariant 17: no GET changes state),
  * the Modisoft check writes nothing; the import creates items,
    departments and products, never doubles an item on re-import, and
    an empty or zero cell never overwrites a value,
  * the migration spells its columns out and imports no app code.
"""
import base64
import importlib.util
from pathlib import Path

import pytest

from tests._app import db, db_session
from tests._xlsx import make_xlsx
from tests.conftest import login_admin, make_employee_client

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "alembic" / "versions" / "c6d2e8a4f1b7_universal_product_catalog.py"
IMPORT_URL = "/api/v2/catalog/import/modisoft"
LOOKUP_URL = "/api/v2/catalog/products/lookup"

HEADER = [
    "Scan Code", "Item Description", "Item Code", "Department", "Tax Rate",
    "Units / Case", "Case Cost", "Case Discount", "Unit Cost After Disc.",
    "Unit Retail", "Margin",
]


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


def _admin(client, store_id):
    return _headers(login_admin(client, store_id))


def _post_import(client, h, data, **body):
    payload = {"content_base64": base64.b64encode(data).decode(), **body}
    return client.post(IMPORT_URL, headers=h, json=payload)


def _row(code, name, *, item="", dept="", tax="", units="", case_cost="",
         discount="", unit_cost="", retail=""):
    return [code, name, item, dept, tax, units, case_cost, discount,
            unit_cost, retail, ""]


def _other_store():
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Second Shop", slug="second-shop")
        db.session.add(other)
        db.session.commit()
        return other.id


def _items(store_id):
    from api.Modules.Catalog.Models import PriceBookItem
    with db_session():
        return {
            i.pos_code: {
                "name": i.name, "price": i.price_cents, "cost": i.cost_cents,
                "dept": i.department.name if i.department else None,
                "taxable": i.is_taxable, "case_size": i.case_size,
                "case_cost": i.case_cost_cents,
                "discount": i.case_discount_cents, "product_id": i.product_id,
                "source": i.source, "item_number": i.item_number,
                "format": i.pos_code_format,
            }
            for i in db.session.query(PriceBookItem).filter_by(store_id=store_id)
        }


def _products():
    from api.Modules.Catalog.Models import Product
    with db_session():
        return {p.gtin: p.name for p in db.session.query(Product)}


# ── Migration ──────────────────────────────────────────────


def _migration():
    spec = importlib.util.spec_from_file_location("upc_migration", MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_columns_match_the_models():
    from api.Modules.Catalog.Models import PriceBookItem, Product
    m = _migration()
    assert tuple(m.PRODUCT_COLUMNS) == tuple(c.name for c in Product.__table__.columns)
    item_columns = {c.name for c in PriceBookItem.__table__.columns}
    assert set(m.ITEM_ADDED) <= item_columns


def test_migration_does_not_import_application_code():
    for line in MIGRATION.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        assert not stripped.startswith(("import api", "from api")), stripped


# ── Scan code normalization ────────────────────────────────


@pytest.mark.parametrize("raw, kind, gtin, note", [
    ("049000006346", "gtin", "00049000006346", ""),          # UPC-A
    ("04900000634", "gtin", "00049000006346", "check_digit_added"),
    ("4900000634", "gtin", "00049000006346", "check_digit_added"),
    ("0049000006346", "gtin", "00049000006346", ""),         # EAN-13
    ("00049000006346", "gtin", "00049000006346", ""),        # GTIN-14
    ("5449000000996", "gtin", "05449000000996", ""),
    ("96385074", "gtin", "00000096385074", ""),              # GTIN-8
    ("10049000006343", "gtin", "10049000006343", ""),        # case code
    ("  049000006346 ", "gtin", "00049000006346", ""),
    ("1", "store", None, "plu"),
    ("123456", "store", None, "plu"),
    ("049000006347", "store", None, "bad_check_digit"),
    ("400001219546", "store", None, "in_store"),             # UPC-A 4…
    ("212345678909", "store", None, "in_store"),             # UPC-A 2…
    ("2001234567893", "store", None, "in_store"),            # EAN 200
    ("ABC-12", "store", None, "not_digits"),
    ("123456789", "store", None, "length"),
    ("", "invalid", None, "empty"),
    ("0000", "invalid", None, "all_zeros"),
    ("1" * 31, "invalid", None, "too_long"),
])
def test_normalize_scan_code(raw, kind, gtin, note):
    from api.Modules.Catalog.Services.barcodes import normalize_scan_code
    code = normalize_scan_code(raw)
    assert (code.kind, code.gtin, code.note) == (kind, gtin, note)
    assert code.raw == raw.strip()


def test_in_store_rule_covers_gtin8_prefixes():
    from api.Modules.Catalog.Services.barcodes import is_in_store_number
    assert is_in_store_number("00000020000007")
    assert is_in_store_number("00000001234565")
    assert not is_in_store_number("00000096385074")
    assert not is_in_store_number("00049000006346")


# ── Linking items to the shared catalog ────────────────────


def test_items_share_one_product_across_stores_and_spellings(client, test_store_id):
    h = _admin(client, test_store_id)
    first = client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "049000006346", "name": "Coke 20oz", "size": "20oz",
        "price": 2.49,
    }).json()["item"]
    assert first["product_id"] is not None
    assert _products() == {"00049000006346": "Coke 20oz"}

    other = _other_store()
    from api.Modules.Catalog.Services import create_item
    with db_session():
        item = create_item(db.session, other, {
            "pos_code": "04900000634", "name": "COCA COLA 20 OZ", "price": 1.99,
        })
        db.session.commit()
        assert item.product_id == first["product_id"]
    # The first store's name stands; the second keeps its own wording.
    assert _products() == {"00049000006346": "Coke 20oz"}
    assert _items(other)["04900000634"]["name"] == "COCA COLA 20 OZ"


def test_store_codes_never_link(client, test_store_id):
    h = _admin(client, test_store_id)
    for code in ("2", "400001219546", "049000006347", "HOTDOG"):
        resp = client.post("/api/v2/catalog/items", headers=h, json={
            "pos_code": code, "name": f"Item {code}", "price": 1,
        })
        assert resp.status_code == 201
        assert resp.json()["item"]["product_id"] is None
    assert _products() == {}


def test_stand_in_name_links_but_never_names_a_product(client, test_store_id):
    from api.Modules.Catalog.Services import create_item
    with db_session():
        item = create_item(db.session, test_store_id, {
            "pos_code": "012345678905", "name": "Item 012345678905",
        }, source="gilbarco", share_name=False)
        db.session.commit()
        assert item.product_id is None
    assert _products() == {}


def test_editing_code_or_name_relinks(client, test_store_id):
    h = _admin(client, test_store_id)
    item = client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "123", "name": "Mystery", "price": 1,
    }).json()["item"]
    assert item["product_id"] is None
    resp = client.put(f"/api/v2/catalog/items/{item['id']}", headers=h, json={
        "pos_code": "012345678905",
    })
    assert resp.json()["item"]["product_id"] is not None
    resp = client.put(f"/api/v2/catalog/items/{item['id']}", headers=h, json={
        "pos_code": "77",
    })
    assert resp.json()["item"]["product_id"] is None


def test_case_discount_roundtrip_and_zero_clears(client, test_store_id):
    h = _admin(client, test_store_id)
    item = client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "555", "name": "Chips", "case_cost": 24, "case_discount": 1.5,
    }).json()["item"]
    assert item["case_discount"] == 1.5
    resp = client.put(f"/api/v2/catalog/items/{item['id']}", headers=h, json={
        "case_discount": 0,
    })
    assert resp.json()["item"]["case_discount"] is None


# ── Scan lookup ────────────────────────────────────────────


def test_lookup_fills_from_another_store_without_leaking_its_item(client, test_store_id):
    other = _other_store()
    from api.Modules.Catalog.Services import create_item
    with db_session():
        create_item(db.session, other, {
            "pos_code": "049000006346", "name": "Coke 20oz", "size": "20oz",
            "price": 9.99, "cost": 7.5,
        })
        db.session.commit()
    h = _admin(client, test_store_id)
    resp = client.get(LOOKUP_URL, headers=h, query_string={"code": "04900000634"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "gtin" and body["gtin"] == "00049000006346"
    assert body["item"] is None
    assert body["product"]["name"] == "Coke 20oz"
    assert body["product"]["size"] == "20oz"
    assert "9.99" not in resp.text and "7.5" not in resp.text


def test_lookup_finds_own_item_by_any_spelling(client, test_store_id):
    h = _admin(client, test_store_id)
    client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "04900000634", "name": "Coke", "price": 2.49,
    })
    for code in ("04900000634", "049000006346", "4900000634"):
        body = client.get(LOOKUP_URL, headers=h, query_string={"code": code}).json()
        assert body["item"]["name"] == "Coke", code
        assert body["item"]["price"] == 2.49


def test_lookup_of_store_code_and_unknown_code(client, test_store_id):
    h = _admin(client, test_store_id)
    client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "7", "name": "Ice bag", "price": 2,
    })
    body = client.get(LOOKUP_URL, headers=h, query_string={"code": "7"}).json()
    assert (body["kind"], body["note"], body["product"]) == ("store", "plu", None)
    assert body["item"]["name"] == "Ice bag"
    body = client.get(LOOKUP_URL, headers=h, query_string={"code": "012345678905"}).json()
    assert body["item"] is None and body["product"] is None
    body = client.get(LOOKUP_URL, headers=h, query_string={"code": "000"}).json()
    assert body["kind"] == "invalid"


def test_lookup_is_read_only_and_needs_catalog_read(client, test_store_id):
    assert client.get(LOOKUP_URL, query_string={"code": "1"}).status_code == 401
    emp, etok = make_employee_client(test_store_id)
    resp = emp.get(LOOKUP_URL, headers=_headers(etok), query_string={"code": "049000006346"})
    assert resp.status_code == 200
    assert _products() == {} and _items(test_store_id) == {}


# ── Modisoft import ────────────────────────────────────────


def _sample():
    return make_xlsx([
        HEADER,
        _row("049000006346", "COKE 20OZ", item="C-1", dept="Soda", tax="8.25",
             units=24, case_cost=36.0, discount=2.4, unit_cost=1.4, retail=2.49),
        _row("04900000634", "COKE 20OZ OTHER SPELLING", dept="soda", tax="8.25",
             retail=2.49),
        _row("7", "ICE BAG", dept="Ice", tax="0.00", retail=2.99),
        _row("", "NO CODE", retail=1),
        _row("012345678905", "", dept="Grocery", retail=1.25),
        _row("7", "ICE BAG AGAIN", retail=3.5),
        _row("400001219546", "SCAN PROGRAM", retail=0, unit_cost="abc"),
        _row("8", "MFG COUPON", retail=-0.5),
    ])


def test_check_reports_and_writes_nothing(client, test_store_id):
    h = _admin(client, test_store_id)
    resp = _post_import(client, h, _sample())
    assert resp.status_code == 200, resp.text
    r = resp.json()
    assert r["applied"] is False
    assert r["rows_read"] == 8
    assert r["items_new"] == 6
    assert r["departments_new"] == ["Grocery", "Ice", "Soda"]
    assert r["products_new"] == 1  # the unnamed row never names one
    assert r["store_codes"] == 3
    issues = {i["code"]: i for i in r["issues"]}
    assert issues["invalid_code"]["count"] == 1
    assert issues["duplicate_code"]["examples"] == [{"line": 7, "scan_code": "7"}]
    assert issues["no_name"]["count"] == 1
    assert issues["bad_number"]["count"] == 1
    assert issues["negative_number"]["examples"] == [{"line": 9, "scan_code": "8"}]
    assert "Margin" in r["columns_ignored"]
    assert _items(test_store_id) == {} and _products() == {}


def test_import_creates_items_departments_and_products(client, test_store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    h = _admin(client, test_store_id)
    r = _post_import(client, h, _sample(), apply=True).json()
    assert r["applied"] is True and r["items_new"] == 6
    items = _items(test_store_id)
    coke = items["049000006346"]
    assert coke == {
        "name": "COKE 20OZ", "price": 249, "cost": 140, "dept": "Soda",
        "taxable": True, "case_size": 24, "case_cost": 3600, "discount": 240,
        "product_id": coke["product_id"], "source": "modisoft",
        "item_number": "C-1", "format": "upc",
    }
    assert items["04900000634"]["product_id"] == coke["product_id"]
    assert items["7"]["taxable"] is False and items["7"]["format"] == "plu"
    assert items["7"]["name"] == "ICE BAG"  # first row wins
    assert items["012345678905"]["name"] == "Item 012345678905"
    assert items["400001219546"]["product_id"] is None
    assert items["8"]["price"] == 0  # a negative amount is left out
    assert _products() == {"00049000006346": "COKE 20OZ"}
    with db_session():
        audit = db.session.query(OperatorAuditLog).filter_by(
            store_id=test_store_id, action="import_price_book",
        ).all()
    assert len(audit) == 1


def test_reimport_changes_nothing(client, test_store_id):
    h = _admin(client, test_store_id)
    _post_import(client, h, _sample(), apply=True)
    r = _post_import(client, h, _sample(), apply=True).json()
    assert r["items_new"] == 0 and r["items_updated"] == 0
    assert r["items_unchanged"] == 6 and r["departments_new"] == []


def test_update_rules_zero_never_overwrites(client, test_store_id):
    h = _admin(client, test_store_id)
    item = client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "04900000634", "name": "Coke (mine)", "price": 2.29,
        "cost": 1.1, "is_taxable": True,
    }).json()["item"]
    data = make_xlsx([
        HEADER,
        _row("049000006346", "COKE 20OZ", tax="0", unit_cost=0, retail=2.59),
    ])
    check = _post_import(client, h, data).json()
    assert check["items_updated"] == 1 and check["matched_other_spelling"] == 1
    r = _post_import(client, h, data, apply=True).json()
    assert (r["items_new"], r["items_updated"]) == (0, 1)
    row = _items(test_store_id)["04900000634"]
    assert row["name"] == "COKE 20OZ" and row["price"] == 259
    assert row["cost"] == 110  # a zero cost cell never overwrites
    assert row["taxable"] is False
    assert row["product_id"] == item["product_id"]


def test_update_existing_off_leaves_items_alone(client, test_store_id):
    h = _admin(client, test_store_id)
    client.post("/api/v2/catalog/items", headers=h, json={
        "pos_code": "7", "name": "Ice", "price": 2,
    })
    data = make_xlsx([HEADER, _row("7", "ICE BAG", retail=9), _row("8", "WATER", retail=1)])
    r = _post_import(client, h, data, apply=True, update_existing=False).json()
    assert (r["items_new"], r["items_skipped"]) == (1, 1)
    assert _items(test_store_id)["7"]["price"] == 200


def test_numeric_scan_codes_are_flagged(client, test_store_id):
    h = _admin(client, test_store_id)
    data = make_xlsx([HEADER, _row(49000006346, "COKE", retail=2)], numeric_first=True)
    r = _post_import(client, h, data).json()
    assert {i["code"] for i in r["issues"]} == {"numeric_code"}


def test_unit_cost_derived_from_case_when_missing(client, test_store_id):
    h = _admin(client, test_store_id)
    data = make_xlsx([HEADER, _row("8", "WATER", units=24, case_cost=12.0,
                                   discount=0.48, retail=1)])
    _post_import(client, h, data, apply=True)
    assert _items(test_store_id)["8"]["cost"] == 48


def test_columns_found_by_name_in_any_order(client, test_store_id):
    h = _admin(client, test_store_id)
    data = make_xlsx([
        ["Exported from Modisoft"],
        ["Unit Retail", "Scan Code", "Item Description"],
        [3.49, "8", "WATER"],
    ])
    r = _post_import(client, h, data, apply=True).json()
    assert r["items_new"] == 1
    assert _items(test_store_id)["8"]["price"] == 349


@pytest.mark.parametrize("data, needle", [
    (b"not a zip", "not an .xlsx"),
    (make_xlsx([["Scan Code", "Item Description"], ["8", "WATER"]]), "Unit Retail"),
    (make_xlsx([["Name", "Price"], ["Water", 1]]), "No header row"),
    (make_xlsx([], sheet_xml=(
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&a;</t></is></c></row>'
        '</sheetData></worksheet>'
    )), "could not be read"),
])
def test_unreadable_files_are_refused(client, test_store_id, data, needle):
    h = _admin(client, test_store_id)
    resp = _post_import(client, h, data)
    assert resp.status_code == 422
    assert needle in resp.json()["detail"]


def test_bad_base64_and_oversize_are_refused(client, test_store_id):
    from api.Modules.Catalog.Requests import MAX_IMPORT_BYTES
    from api.Core.Uploads import b64_len
    h = _admin(client, test_store_id)
    resp = client.post(IMPORT_URL, headers=h, json={"content_base64": "@@@"})
    assert resp.status_code == 422
    resp = client.post(IMPORT_URL, headers=h, json={
        "content_base64": "A" * (b64_len(MAX_IMPORT_BYTES) + 4),
    })
    assert resp.status_code == 422


def test_row_and_size_caps(client, test_store_id, monkeypatch):
    from api.Core import Xlsx as xlsx
    from api.Modules.Catalog.Services import modisoft_import
    h = _admin(client, test_store_id)
    monkeypatch.setattr(modisoft_import, "MAX_ROWS", 2)
    data = make_xlsx([HEADER] + [_row(str(n), "X", retail=1) for n in range(20, 40)])
    resp = _post_import(client, h, data)
    assert resp.status_code == 422 and "rows" in resp.json()["detail"]
    monkeypatch.setattr(modisoft_import, "MAX_ROWS", 60_000)
    monkeypatch.setattr(xlsx, "MAX_PART_BYTES", 512)
    resp = _post_import(client, h, data)
    assert resp.status_code == 422 and "too large" in resp.json()["detail"]


def test_import_needs_catalog_update(client, test_store_id):
    assert client.post(IMPORT_URL, json={"content_base64": "AA=="}).status_code == 401
    emp, etok = make_employee_client(test_store_id)
    data = base64.b64encode(_sample()).decode()
    resp = emp.post(IMPORT_URL, headers=_headers(etok), json={"content_base64": data})
    assert resp.status_code == 403
