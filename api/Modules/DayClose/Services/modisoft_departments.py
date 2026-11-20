"""Import departments from a Modisoft "Departments" export.

A store moving from Modisoft brings its department list: Setup →
Departments exports one row per department with POS Dept, Department
Name, Depart Type, NACS Code, Tax Rate, Min Age and Items (a real
export, 2026-11-19: named ``.xls`` but an ``.xlsx`` inside, with the
store name and two title lines above the header). Columns are found by
name, so their order does not matter.

Two steps:

* ``check_file`` reads the file and plans every row against the
  store's departments. It writes nothing.
* ``apply_rows`` takes the rows the person kept, each with the type
  they chose, and creates or updates the departments in one
  transaction (the Controller commits after the audit row).

**Types.** Modisoft has five department types (Fuel, Merchandise,
Lottery, Misc, Services). DineroBook's types also say which daily book
line a department's sales land on, so Lottery and Services split into
four and six. Fuel, Merchandise and Misc map one to one. A Lottery or
Services row gets a guess from its name ("LOTTO PAID OUT" → lotto paid
out, "MONEY ORDERS FEE" → money order fee) and is marked for the
person to confirm before anything is saved (owner, 2026-11-19: "Import
mein hi"). A department the store already set up within the same
group keeps its own type.

**Matching.** A row is matched to a department by its register number
first, then by name (ignoring case), so a re-import never doubles a
department. A matched department takes the file's name, type, tax,
age and NACS code, and gains the row's register number; a blank cell
leaves a value alone. A number that already belongs to a different
department than the name points at is refused, never moved: the
register import books that number's sales wherever it sits.

**Rows nobody uses.** Modisoft writes -1 as the POS Dept of a
department that is not on the register. Such a row with no items
(leftovers like "DeptName" or a duplicate "FROZEN FOODS") is offered
unticked.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy.orm import Session

from api.Core.Xlsx import Cell, XlsxError, iter_first_sheet
from api.Modules.DayClose.Models import Department
from api.Modules.DayClose.Services import (
    DayCloseStateError,
    create_department,
    pos_codes_by_department,
    update_department,
)

MAX_ROWS = 2_000
NAME_MAX = 80
_HEADER_SEARCH_ROWS = 15
_POS_CODE = re.compile(r"^[0-9A-Za-z]{1,20}$")
_NACS_CODE = re.compile(r"^[0-9A-Za-z]{1,10}$")

# Normalized header (lowercase letters and digits only) → field.
HEADERS: dict[str, str] = {
    "posdept": "pos", "posdeptno": "pos", "posdepartment": "pos",
    "posdeptnumber": "pos", "deptno": "pos", "departmentnumber": "pos",
    "departmentname": "name", "deptname": "name", "department": "name",
    "departtype": "type", "departmenttype": "type", "depttype": "type",
    "type": "type",
    "nacscode": "nacs", "nacs": "nacs",
    "taxrate": "tax", "tax": "tax",
    "minage": "age", "minimumage": "age", "age": "age",
    "items": "items", "itemcount": "items", "noofitems": "items",
}

# Modisoft's type → DineroBook's type group (DepartmentsManager's
# TYPE_GROUPS) and the types each group holds.
GROUP_TYPES: dict[str, tuple[str, ...]] = {
    "merchandise": ("merchandise",),
    "fuel": ("fuel",),
    "lottery": ("lottery_sell", "lottery_cash", "lotto_sell", "lotto_cash"),
    "services": (
        "money_order", "money_order_fee", "money_transfer",
        "money_transfer_fee", "check_cash_fee", "service",
    ),
    "misc": ("misc",),
}
_MODISOFT_GROUP = {
    "merchandise": "merchandise", "fuel": "fuel", "lottery": "lottery",
    "services": "services", "service": "services", "misc": "misc",
    "miscellaneous": "misc",
}
# Groups whose one type needs no confirming.
_EXACT_GROUPS = ("merchandise", "fuel", "misc")

ISSUE_CODES = ("no_name", "bad_number", "bad_pos", "bad_nacs")

# Min Age cells that mean "no age limit" (Modisoft writes "No Restriction").
_NO_AGE_LIMIT = frozenset({"norestriction", "none", "no", "na", "noage"})


class ImportFileError(ValueError):
    """The file cannot be imported at all (shown to the user)."""


def _header_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _clean(text: str) -> str:
    return " ".join(text.split())


def _number_text(text: str) -> str:
    """Excel keeps whole numbers as ``7`` or ``7.0``; both read ``7``."""
    t = text.strip()
    return t[:-2] if t.endswith(".0") and t[:-2].lstrip("-").isdigit() else t


def guess_type(group: str, name: str) -> str:
    """DineroBook's type for a Modisoft group, using the department's
    name to pick within Lottery and Services."""
    words = " " + re.sub(r"[^A-Z0-9]+", " ", name.upper()) + " "
    if group == "lottery":
        paid = any(w in words for w in (
            " PAID", " PAYOUT", " PAY OUT", " CASHED", " CASH ", " WIN",
            " REDEEM",
        ))
        if "LOTTO" in words:
            return "lotto_cash" if paid else "lotto_sell"
        return "lottery_cash" if paid else "lottery_sell"
    if group == "services":
        fee = " FEE" in words
        if " ORDER" in words or " MO " in words:
            return "money_order_fee" if fee else "money_order"
        if any(w in words for w in (
            " TRANSFER", " WIRE", " REMIT", " INTERMEX", " MAXI ", " BARRI",
            " WESTERN UNION", " MONEYGRAM", " RIA ",
        )):
            return "money_transfer_fee" if fee else "money_transfer"
        if " CHECK" in words or " CHEQUE" in words:
            return "check_cash_fee"
        return "service"
    return GROUP_TYPES.get(group, ("merchandise",))[0]


def group_of(department_type: str) -> str:
    for group, types in GROUP_TYPES.items():
        if department_type in types:
            return group
    return ""


@dataclass
class Issue:
    count: int = 0
    lines: list[int] = field(default_factory=list)

    def add(self, line: int) -> None:
        self.count += 1
        if len(self.lines) < 5:
            self.lines.append(line)


@dataclass
class FileRow:
    """One department as the file has it."""
    line: int
    name: str
    pos_code: str | None
    modisoft_type: str
    group: str                 # DineroBook group, "" when unknown
    is_taxable: bool | None    # None = blank or unreadable
    tax_rate: float | None     # a fraction (0.0825)
    min_age: int | None        # 0 = no restriction, None = blank
    nacs_code: str | None
    items: int | None


@dataclass
class PlannedRow:
    row: FileRow
    department_type: str
    type_sure: bool
    status: str                # new / update / same / skip
    existing_id: int | None = None
    existing_name: str = ""
    existing_type: str | None = None
    changes: list[str] = field(default_factory=list)
    problem: str | None = None
    problem_name: str = ""
    unused: bool = False
    include: bool = True


@dataclass
class CheckReport:
    rows: list[PlannedRow] = field(default_factory=list)
    columns_used: list[str] = field(default_factory=list)
    columns_ignored: list[str] = field(default_factory=list)
    issues: dict[str, Issue] = field(default_factory=dict)

    def issue(self, code: str) -> Issue:
        return self.issues.setdefault(code, Issue())


# ── Reading the file ───────────────────────────────────────


def _decimal(text: str) -> Decimal | None:
    try:
        value = Decimal(text.replace("%", "").replace(",", "").strip())
    except InvalidOperation:
        return None
    return value if value.is_finite() else None


def _parse_row(
    cells: list[Cell], columns: dict[str, int], line: int, report: CheckReport,
) -> FileRow | None:
    def text(key: str) -> str:
        i = columns.get(key)
        return cells[i].text if i is not None and i < len(cells) else ""

    if not any(c.text.strip() for c in cells):
        return None  # blank line
    name = _clean(text("name"))[:NAME_MAX]
    if not name:
        report.issue("no_name").add(line)
        return None

    pos_code: str | None = _number_text(text("pos")) or None
    if pos_code is not None and (pos_code.startswith("-") or pos_code == "0"):
        pos_code = None  # Modisoft's -1: not on the register
    if pos_code is not None and not _POS_CODE.match(pos_code):
        report.issue("bad_pos").add(line)
        pos_code = None

    modisoft_type = _clean(text("type"))
    group = _MODISOFT_GROUP.get(modisoft_type.lower(), "")

    is_taxable: bool | None = None
    tax_rate: float | None = None
    tax_text = text("tax").strip()
    if tax_text:
        rate = _decimal(tax_text)
        if rate is None or rate < 0 or rate > 100:
            report.issue("bad_number").add(line)
        else:
            is_taxable = rate > 0
            tax_rate = round(float(rate) / 100, 6) if rate > 0 else None

    min_age: int | None = None
    age_text = _number_text(text("age"))
    if age_text:
        if _header_key(age_text) in _NO_AGE_LIMIT:
            min_age = 0
        elif age_text.isdigit() and 0 <= int(age_text) <= 99:
            min_age = int(age_text)
        else:
            report.issue("bad_number").add(line)

    nacs_code: str | None = _number_text(text("nacs")) or None
    if nacs_code is not None and not _NACS_CODE.match(nacs_code):
        report.issue("bad_nacs").add(line)
        nacs_code = None

    items: int | None = None
    items_text = _number_text(text("items"))
    if items_text.isdigit():
        items = int(items_text)

    return FileRow(
        line=line, name=name, pos_code=pos_code,
        modisoft_type=modisoft_type, group=group,
        is_taxable=is_taxable, tax_rate=tax_rate, min_age=min_age,
        nacs_code=nacs_code, items=items,
    )


def read_file(data: bytes) -> tuple[list[FileRow], CheckReport]:
    """Parse the export. Raises ``ImportFileError`` when the file is
    unreadable or has no department header row."""
    report = CheckReport()
    columns: dict[str, int] = {}
    rows: list[FileRow] = []
    line = 0
    try:
        for cells in iter_first_sheet(data, max_rows=MAX_ROWS + _HEADER_SEARCH_ROWS):
            line += 1
            if not columns:
                found = {
                    HEADERS[_header_key(c.text)]: i
                    for i, c in reversed(list(enumerate(cells)))
                    if _header_key(c.text) in HEADERS
                }
                if "name" in found and ("type" in found or "pos" in found):
                    columns = found
                    report.columns_used = [
                        c.text.strip() for c in cells if _header_key(c.text) in HEADERS
                    ]
                    report.columns_ignored = [
                        c.text.strip() for c in cells
                        if c.text.strip() and _header_key(c.text) not in HEADERS
                    ]
                elif line >= _HEADER_SEARCH_ROWS:
                    break
                continue
            row = _parse_row(cells, columns, line, report)
            if row is not None:
                rows.append(row)
    except XlsxError as exc:
        raise ImportFileError(str(exc)) from exc
    if not columns:
        raise ImportFileError(
            "No header row with Department Name and Depart Type was found. "
            "Export the departments from Modisoft and upload that file."
        )
    if len(rows) > MAX_ROWS:
        raise ImportFileError(f"The file has more than {MAX_ROWS:,} departments.")
    return rows, report


# ── Matching against the store ─────────────────────────────


@dataclass
class _Store:
    by_id: dict[int, Department]
    by_name: dict[str, Department]
    by_code: dict[str, Department]
    codes: dict[int, list[str]]


def _load_store(db: Session, store_id: int) -> _Store:
    depts = db.query(Department).filter(Department.store_id == store_id).all()
    by_id = {d.id: d for d in depts}
    codes = pos_codes_by_department(db, store_id)
    by_code = {
        code: by_id[dept_id]
        for dept_id, dept_codes in codes.items() if dept_id in by_id
        for code in dept_codes
    }
    return _Store(
        by_id=by_id,
        by_name={(d.name or "").lower(): d for d in depts},
        by_code=by_code, codes=codes,
    )


@dataclass
class _Wanted:
    """What a row asks of a department (None = leave alone)."""
    name: str
    pos_code: str | None
    department_type: str
    is_taxable: bool | None
    tax_rate: float | None
    min_age: int | None
    nacs_code: str | None


def _target(
    store: _Store, want: _Wanted,
) -> tuple[Department | None, str | None, str]:
    """The department a row updates, or a problem (code, other name)."""
    by_code = store.by_code.get(want.pos_code) if want.pos_code else None
    by_name = store.by_name.get(want.name.lower())
    if by_code is not None and by_name is not None and by_code.id != by_name.id:
        return None, "pos_taken", by_code.name or ""
    target = by_code or by_name
    if target is not None and want.name.lower() != (target.name or "").lower():
        other = store.by_name.get(want.name.lower())
        if other is not None and other.id != target.id:
            return None, "name_taken", other.name or ""
    return target, None, ""


def _changes(store: _Store, dept: Department, want: _Wanted) -> list[str]:
    out: list[str] = []
    if want.name != (dept.name or ""):
        out.append("name")
    if want.department_type != (dept.department_type or "merchandise"):
        out.append("type")
    if want.is_taxable is not None:
        rate = want.tax_rate if want.is_taxable else None
        have = float(dept.tax_rate) if dept.tax_rate else None
        if want.is_taxable != bool(dept.is_taxable) or (
            want.is_taxable and rate is not None and rate != have
        ):
            out.append("tax")
    if want.min_age is not None and (want.min_age or None) != (dept.min_age or None):
        out.append("age")
    if want.nacs_code is not None and want.nacs_code != (dept.nacs_code or ""):
        out.append("nacs")
    if want.pos_code and want.pos_code not in store.codes.get(dept.id, []):
        out.append("pos")
    return out


def check_file(db: Session, store_id: int, data: bytes) -> CheckReport:
    """Read the export and plan each row. Writes nothing."""
    rows, report = read_file(data)
    store = _load_store(db, store_id)
    seen_names: set[str] = set()
    seen_codes: set[str] = set()
    for row in rows:
        guess = guess_type(row.group, row.name)
        sure = row.group in _EXACT_GROUPS
        want = _Wanted(
            name=row.name, pos_code=row.pos_code, department_type=guess,
            is_taxable=row.is_taxable, tax_rate=row.tax_rate,
            min_age=row.min_age, nacs_code=row.nacs_code,
        )
        planned = PlannedRow(row=row, department_type=guess, type_sure=sure, status="new")
        planned.unused = row.pos_code is None and not row.items
        planned.include = not planned.unused
        report.rows.append(planned)

        key = row.name.lower()
        if key in seen_names:
            planned.status, planned.problem, planned.include = "skip", "duplicate_name", False
            continue
        if row.pos_code and row.pos_code in seen_codes:
            planned.status, planned.problem, planned.include = "skip", "duplicate_pos", False
            continue
        seen_names.add(key)
        if row.pos_code:
            seen_codes.add(row.pos_code)

        target, problem, other = _target(store, want)
        if problem:
            planned.status, planned.problem, planned.problem_name = "skip", problem, other
            planned.include = False
            continue
        if target is None:
            continue
        planned.existing_id = target.id
        planned.existing_name = target.name or ""
        planned.existing_type = target.department_type or "merchandise"
        # A type the store already chose within the same group stays.
        if row.group and group_of(planned.existing_type) == row.group:
            planned.department_type = want.department_type = planned.existing_type
            planned.type_sure = True
        planned.changes = _changes(store, target, want)
        planned.status = "update" if planned.changes else "same"
    return report


# ── Importing the reviewed rows ────────────────────────────


@dataclass
class ApplyResult:
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    names: list[str] = field(default_factory=list)


def apply_rows(db: Session, store_id: int, rows: list[dict[str, Any]]) -> ApplyResult:
    """Create or update a department per reviewed row. Any refused row
    raises ``DayCloseStateError`` (409) and the caller rolls back, so
    an import lands whole or not at all."""
    wanted = [_Wanted(**r) for r in rows]
    names = [w.name.lower() for w in wanted]
    dup_name = next((w.name for i, w in enumerate(wanted) if w.name.lower() in names[:i]), None)
    if dup_name:
        raise DayCloseStateError(f"{dup_name!r} is in the import twice.")
    codes = [w.pos_code for w in wanted if w.pos_code]
    dup_code = next((c for i, c in enumerate(codes) if c in codes[:i]), None)
    if dup_code:
        raise DayCloseStateError(f"POS dept no {dup_code} is in the import twice.")

    store = _load_store(db, store_id)
    result = ApplyResult()
    for want in wanted:
        target, problem, other = _target(store, want)
        if problem == "pos_taken":
            raise DayCloseStateError(
                f"POS dept no {want.pos_code} already belongs to {other!r}.",
            )
        if problem == "name_taken":
            raise DayCloseStateError(
                f"A department named {other!r} already exists.",
            )
        if target is None:
            taxable = (
                want.is_taxable if want.is_taxable is not None
                else want.department_type == "merchandise"
            )
            dept = create_department(
                db, store_id, name=want.name,
                department_type=want.department_type,
                is_taxable=taxable,
                tax_rate=want.tax_rate if taxable else None,
                min_age=want.min_age or None,
                nacs_code=want.nacs_code or "",
                pos_codes=[want.pos_code] if want.pos_code else None,
            )
            store.by_name[dept.name.lower()] = dept
            if want.pos_code:
                store.by_code[want.pos_code] = dept
                store.codes[dept.id] = [want.pos_code]
            result.created += 1
            result.names.append(dept.name)
            continue
        changes = _changes(store, target, want)
        if not changes:
            result.unchanged += 1
            continue
        old_key = (target.name or "").lower()
        new_codes = None
        if "pos" in changes and want.pos_code:
            new_codes = [*store.codes.get(target.id, []), want.pos_code]
        update_department(
            db, store_id, target.id,
            name=want.name if "name" in changes else None,
            department_type=want.department_type,
            is_taxable=want.is_taxable,
            # None leaves the department's own rate as it is.
            tax_rate=want.tax_rate if want.is_taxable else None,
            min_age=want.min_age,
            nacs_code=want.nacs_code,
            pos_codes=new_codes,
        )
        if "name" in changes:
            store.by_name.pop(old_key, None)
            store.by_name[want.name.lower()] = target
        if new_codes is not None and want.pos_code:
            store.codes[target.id] = new_codes
            store.by_code[want.pos_code] = target
        result.updated += 1
        result.names.append(target.name or "")
    db.flush()
    return result
