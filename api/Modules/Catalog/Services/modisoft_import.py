"""Import a Modisoft price book export (.xlsx) into a store's price book.

Modisoft's "Vendors Price Book" export has one row per item: Scan Code,
Item Description, Item Code, (Department, Tax Rate,) Units / Case, Case
Cost, Case Discount, Unit Cost After Disc., Unit Retail, Margin. Columns
are found by name, so their order and the optional ones do not matter.

Two steps with the same file: a **check** (``apply=False``) that writes
nothing and reports what would happen, then the **import**.

Rules:

* An item is matched to the store's price book by its scan code exactly
  as written; failing that, by another spelling of the same GTIN
  (``04900000634`` and ``049000006346`` are one can of soda), so a
  re-import never doubles an item. Unmatched rows become new items
  (source ``modisoft``).
* Existing items take the file's values, except that **an empty or zero
  cell never overwrites a value already in the price book** (Modisoft
  exports 0 for a cost nobody keyed). A stand-in name never replaces a
  real one. Active / inactive is left alone. With ``update_existing``
  off, existing items are not touched at all.
* Departments are matched by name, ignoring case; missing ones are
  created. Tax Rate above 0 means taxable.
* Rows with no usable scan code are skipped; when a code repeats, the
  first row wins. Each problem is counted with a few line numbers.
* Real GTINs join the universal catalog (Services/products.py); the
  store's price, cost, department and tax never leave its own items.

Writes are bulk statements: a 20,000-row file is a handful of queries
plus one INSERT batch, not 60,000 round trips.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from sqlalchemy import insert, update
from sqlalchemy.orm import Session

from api.Core.Clock import utc_now
from api.Modules.Catalog.Models import PriceBookItem
from api.Modules.Catalog.Services.barcodes import ScanCode, normalize_scan_code
from api.Modules.Catalog.Services.products import (
    NAME_MAX, ProductSeed, ensure_products, products_by_gtin,
)
from api.Core.Xlsx import Cell, XlsxError, iter_first_sheet
from api.Modules.DayClose.Models import Department

SOURCE = "modisoft"
MAX_ROWS = 60_000
DEPARTMENT_NAME_MAX = 80
ITEM_NUMBER_MAX = 40
MAX_MONEY = Decimal("1000000")
MAX_CASE_SIZE = 100_000
EXAMPLES_PER_ISSUE = 5
# How many rows above the header we look through (title lines).
_HEADER_SEARCH_ROWS = 10

# Normalized header (lowercase letters and digits only) → field.
HEADERS: dict[str, str] = {
    "scancode": "scan_code", "upc": "scan_code", "barcode": "scan_code",
    "itemdescription": "name", "description": "name", "itemname": "name",
    "itemcode": "item_number", "vendoritemcode": "item_number",
    "department": "department", "departmentname": "department",
    "taxrate": "tax_rate",
    "unitscase": "case_size", "unitspercase": "case_size",
    "casesize": "case_size",
    "casecost": "case_cost",
    "casediscount": "case_discount",
    "unitcostafterdisc": "unit_cost", "unitcost": "unit_cost",
    "unitretail": "price", "retailprice": "price", "retail": "price",
}
REQUIRED: tuple[tuple[str, str], ...] = (
    ("scan_code", "Scan Code"),
    ("name", "Item Description"),
    ("price", "Unit Retail"),
)

# Issue codes the report (and the page) knows.
ISSUE_CODES = (
    "invalid_code", "duplicate_code", "no_name", "bad_number",
    "negative_number", "numeric_code",
)


class ImportFileError(ValueError):
    """The file cannot be imported at all (shown to the user)."""


def _header_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _clean(text: str) -> str:
    return " ".join(text.split())


@dataclass
class ParsedRow:
    line: int
    code: ScanCode
    numeric_code: bool
    name: str
    has_name: bool
    item_number: str | None
    department: str | None
    taxable: bool | None
    case_size: int | None
    case_cost_cents: int | None
    case_discount_cents: int | None
    cost_cents: int | None
    price_cents: int | None


@dataclass
class Issue:
    count: int = 0
    examples: list[tuple[int, str]] = field(default_factory=list)

    def add(self, line: int, code: str) -> None:
        self.count += 1
        if len(self.examples) < EXAMPLES_PER_ISSUE:
            self.examples.append((line, code))


@dataclass
class ImportReport:
    applied: bool
    rows_read: int = 0
    items_new: int = 0
    items_updated: int = 0
    items_unchanged: int = 0
    items_skipped: int = 0
    matched_other_spelling: int = 0
    products_new: int = 0
    products_known: int = 0
    store_codes: int = 0
    departments_new: list[str] = field(default_factory=list)
    columns_used: list[str] = field(default_factory=list)
    columns_ignored: list[str] = field(default_factory=list)
    issues: dict[str, Issue] = field(default_factory=dict)

    def issue(self, code: str) -> Issue:
        return self.issues.setdefault(code, Issue())


# ── Reading ────────────────────────────────────────────────


def _money(cell: Cell, report: ImportReport, line: int, code: str) -> int | None:
    """Dollars text → cents. Empty → None. Unreadable or absurd →
    None plus a ``bad_number`` issue; below zero (Modisoft keeps
    coupons and discounts as negative items, and the price book holds
    no negative amounts) → None plus ``negative_number``."""
    text = cell.text.strip().replace("$", "").replace(",", "")
    if not text:
        return None
    try:
        value = Decimal(text)
    except InvalidOperation:
        value = Decimal("NaN")
    if value.is_finite() and value < 0:
        report.issue("negative_number").add(line, code)
        return None
    if not value.is_finite() or value > MAX_MONEY:
        report.issue("bad_number").add(line, code)
        return None
    return int((value * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _case_size(cell: Cell, report: ImportReport, line: int, code: str) -> int | None:
    text = cell.text.strip().replace(",", "")
    if not text:
        return None
    try:
        value = Decimal(text)
    except InvalidOperation:
        value = Decimal("NaN")
    if value.is_finite() and value < 0:
        report.issue("negative_number").add(line, code)
        return None
    if (
        not value.is_finite() or value != value.to_integral_value()
        or value > MAX_CASE_SIZE
    ):
        report.issue("bad_number").add(line, code)
        return None
    return int(value) or None


def _taxable(cell: Cell, report: ImportReport, line: int, code: str) -> bool | None:
    text = cell.text.strip().replace("%", "")
    if not text:
        return None
    try:
        value = Decimal(text)
    except InvalidOperation:
        report.issue("bad_number").add(line, code)
        return None
    if not value.is_finite():
        report.issue("bad_number").add(line, code)
        return None
    return value > 0


def read_rows(data: bytes) -> tuple[list[ParsedRow], ImportReport]:
    """Parse the export. Raises ``ImportFileError`` when the file is
    unreadable or lacks a required column."""
    report = ImportReport(applied=False)
    try:
        rows = iter_first_sheet(data, max_rows=MAX_ROWS + _HEADER_SEARCH_ROWS)
        columns: dict[str, int] = {}
        header_line = 0
        line = 0
        parsed: list[ParsedRow] = []
        for cells in rows:
            line += 1
            if not columns:
                found = {
                    HEADERS[_header_key(c.text)]: i
                    for i, c in reversed(list(enumerate(cells)))
                    if _header_key(c.text) in HEADERS
                }
                if "scan_code" in found and "name" in found:
                    columns, header_line = found, line
                    report.columns_used = [
                        c.text.strip() for c in cells
                        if _header_key(c.text) in HEADERS
                    ]
                    report.columns_ignored = [
                        c.text.strip() for c in cells
                        if c.text.strip() and _header_key(c.text) not in HEADERS
                    ]
                    missing = [label for key, label in REQUIRED if key not in columns]
                    if missing:
                        raise ImportFileError(
                            "The file has no " + ", ".join(missing) + " column."
                        )
                elif line >= _HEADER_SEARCH_ROWS:
                    break
                continue
            row = _parse_row(cells, columns, line, report)
            if row is not None:
                parsed.append(row)
    except XlsxError as exc:
        raise ImportFileError(str(exc)) from exc
    if not columns:
        raise ImportFileError(
            "No header row with Scan Code and Item Description was found. "
            "Export the price book from Modisoft and upload that file."
        )
    report.rows_read = line - header_line
    if report.rows_read > MAX_ROWS:
        raise ImportFileError(f"The file has more than {MAX_ROWS:,} items.")
    return parsed, report


def _parse_row(
    cells: list[Cell], columns: dict[str, int], line: int, report: ImportReport,
) -> ParsedRow | None:
    def cell(key: str) -> Cell:
        i = columns.get(key)
        return cells[i] if i is not None and i < len(cells) else Cell("")

    if not any(c.text.strip() for c in cells):
        return None  # blank line
    raw = cell("scan_code")
    code = normalize_scan_code(raw.text)
    if code.kind == "invalid":
        report.issue("invalid_code").add(line, raw.text.strip()[:30])
        return None
    shown = code.raw
    name = _clean(cell("name").text)[:NAME_MAX]
    has_name = bool(name)
    if not has_name:
        name = f"Item {shown}"[:NAME_MAX]
        report.issue("no_name").add(line, shown)
    if raw.numeric:
        report.issue("numeric_code").add(line, shown)
    department = _clean(cell("department").text)[:DEPARTMENT_NAME_MAX] or None
    item_number = _clean(cell("item_number").text)[:ITEM_NUMBER_MAX] or None
    case_size = _case_size(cell("case_size"), report, line, shown)
    case_cost = _money(cell("case_cost"), report, line, shown)
    discount = _money(cell("case_discount"), report, line, shown)
    cost = _money(cell("unit_cost"), report, line, shown)
    if cost is None and case_cost and case_size:
        net = max(case_cost - (discount or 0), 0)
        cost = int((Decimal(net) / case_size).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return ParsedRow(
        line=line, code=code, numeric_code=raw.numeric,
        name=name, has_name=has_name, item_number=item_number,
        department=department,
        taxable=_taxable(cell("tax_rate"), report, line, shown),
        case_size=case_size, case_cost_cents=case_cost,
        case_discount_cents=discount, cost_cents=cost,
        price_cents=_money(cell("price"), report, line, shown),
    )


# ── Planning + applying ────────────────────────────────────

_EXISTING_COLUMNS = (
    PriceBookItem.id, PriceBookItem.pos_code, PriceBookItem.name,
    PriceBookItem.item_number, PriceBookItem.department_id,
    PriceBookItem.is_taxable, PriceBookItem.price_cents,
    PriceBookItem.cost_cents, PriceBookItem.case_size,
    PriceBookItem.case_cost_cents, PriceBookItem.case_discount_cents,
    PriceBookItem.product_id,
)


def _changes(
    existing: Any, row: ParsedRow, department_id: int | None,
    product_id: int | None,
) -> dict[str, Any]:
    """The fields an existing item takes from the row (empty / zero
    cells never overwrite; a stand-in name never replaces a real one)."""
    out: dict[str, Any] = {}

    def put(column: str, value: Any) -> None:
        if value is not None and getattr(existing, column) != value:
            out[column] = value

    if row.has_name:
        put("name", row.name)
    put("item_number", row.item_number)
    put("department_id", department_id)
    put("is_taxable", row.taxable)
    put("price_cents", row.price_cents or None)
    put("cost_cents", row.cost_cents or None)
    put("case_size", row.case_size)
    put("case_cost_cents", row.case_cost_cents or None)
    put("case_discount_cents", row.case_discount_cents or None)
    if existing.product_id is None:
        put("product_id", product_id)
    return out


def run_import(
    db: Session, store_id: int, data: bytes, *,
    apply: bool, update_existing: bool = True,
) -> ImportReport:
    """Check (``apply=False``, writes nothing) or import the file.
    The caller commits."""
    rows, report = read_rows(data)
    report.applied = apply

    # First row wins for a repeated scan code.
    seen: set[str] = set()
    unique: list[ParsedRow] = []
    for row in rows:
        if row.code.raw in seen:
            report.issue("duplicate_code").add(row.line, row.code.raw)
            continue
        seen.add(row.code.raw)
        unique.append(row)

    existing = db.query(*_EXISTING_COLUMNS).filter(
        PriceBookItem.store_id == store_id,
    ).all()
    by_code = {str(e.pos_code): e for e in existing}
    by_gtin: dict[str, Any] = {}
    for e in existing:
        g = normalize_scan_code(e.pos_code).gtin
        if g and g not in by_gtin:
            by_gtin[g] = e

    # Departments, by name ignoring case (inactive ones count too).
    departments = {
        str(name).lower(): int(did)
        for did, name in db.query(Department.id, Department.name)
                           .filter(Department.store_id == store_id).all()
    }
    wanted_departments: dict[str, str] = {}
    for row in unique:
        if row.department and row.department.lower() not in departments:
            wanted_departments.setdefault(row.department.lower(), row.department)
    report.departments_new = sorted(wanted_departments.values(), key=str.lower)

    gtins = {row.code.gtin for row in unique if row.code.gtin}
    report.store_codes = sum(1 for row in unique if row.code.gtin is None)
    known = products_by_gtin(db, gtins)
    report.products_known = len(known)

    seeds = [
        ProductSeed(row.code.gtin, row.name)
        for row in unique if row.code.gtin and row.has_name
    ]
    product_ids = {g: int(p.id) for g, p in known.items()}
    if apply:
        for key, name in wanted_departments.items():
            dept = Department(store_id=store_id, name=name)
            db.add(dept)
            db.flush()
            departments[key] = int(dept.id)
        products, report.products_new = ensure_products(db, seeds, source=SOURCE)
        product_ids = {g: int(p.id) for g, p in products.items()}
    else:
        # Stand-in ids so the check counts the same updates the import
        # will make (an item gaining a new department or product).
        for i, key in enumerate(wanted_departments, start=1):
            departments[key] = -i
        to_create = {s.gtin for s in seeds} - set(known)
        report.products_new = len(to_create)
        product_ids.update({g: -1 for g in to_create})

    claimed: set[int] = set()
    # Rows that match an item exactly claim it before any other
    # spelling of the same GTIN can.
    for row in unique:
        e = by_code.get(row.code.raw)
        if e is not None:
            claimed.add(int(e.id))

    new_rows: list[dict[str, Any]] = []
    updates: list[dict[str, Any]] = []
    now = utc_now()
    for row in unique:
        product_id = product_ids.get(row.code.gtin) if row.code.gtin else None
        department_id = (
            departments.get(row.department.lower()) if row.department else None
        )
        match = by_code.get(row.code.raw)
        if match is None and row.code.gtin:
            other = by_gtin.get(row.code.gtin)
            if other is not None and int(other.id) not in claimed:
                match = other
                claimed.add(int(other.id))
                report.matched_other_spelling += 1
        if match is not None:
            if not update_existing:
                report.items_skipped += 1
                continue
            changes = _changes(match, row, department_id, product_id)
            if changes:
                report.items_updated += 1
                updates.append({"id": int(match.id), **changes, "updated_at": now})
            else:
                report.items_unchanged += 1
            continue
        report.items_new += 1
        new_rows.append({
            "store_id": store_id,
            "pos_code": row.code.raw,
            "pos_code_format": "plu" if row.code.note == "plu" else "upc",
            "name": row.name,
            "department_id": department_id,
            "vendor_id": None,
            "price_cents": row.price_cents or 0,
            "cost_cents": row.cost_cents or 0,
            "is_taxable": True if row.taxable is None else row.taxable,
            "is_active": True,
            "item_number": row.item_number or "",
            "size": "",
            "case_size": row.case_size,
            "case_cost_cents": row.case_cost_cents,
            "case_discount_cents": row.case_discount_cents,
            "is_ebt": False,
            "source": SOURCE,
            "product_id": product_id,
            "created_at": now,
            "updated_at": now,
        })

    if apply:
        if new_rows:
            db.execute(insert(PriceBookItem), new_rows)
        if updates:
            db.execute(update(PriceBookItem), updates)
        db.flush()
    return report


__all__ = [
    "ISSUE_CODES", "ImportFileError", "ImportReport", "Issue", "MAX_ROWS",
    "ParsedRow", "SOURCE", "read_rows", "run_import",
]
