"""DayClose module — Controllers (FastAPI router).

Mounts at `/api/v2/dayclose/*`:

  GET    /departments              list departments (?include_inactive=1)
  POST   /departments              create department
  PUT    /departments/{id}         rename / reorder / deactivate, and the
                                   setup fields (type, taxable, min age,
                                   NACS code, register numbers)
  POST   /departments/import/modisoft/check
                                   read a Modisoft departments export
                                   and plan each row (writes nothing)
  POST   /departments/import/modisoft
                                   create / update the reviewed rows
  GET    /day/{date}               day summary (closes + dept rollup)
  POST   /day/{date}/closes        upsert one register/shift close
                                   (replaces on the same register +
                                   shift key; dept lines replace-all)
  DELETE /closes/{id}              remove a close (admin)

Cashiers (employees) hold day_close.create/read so they can submit
their own shift close; a day locked on the store daily book refuses
both writes (409) until it is unlocked; department catalog + deletions need admin
update rights. Every mutation records an operator-audit row
(invariant #7).
"""
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from api.Core.Audit import audit_operator
from api.Core.Clock import parse_iso_day
from api.Core.Database import get_db
from api.Core.Money import to_dollars
from api.Core.Uploads import decode_base64
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services.principal import (
    require_permission,
    resolve_store_scope,
)
from api.Modules.DayClose.Models import Department, RegisterClose
from api.Modules.DayClose.Requests import (
    DayCloseSummaryResponse,
    DepartmentImportCheckRequest,
    DepartmentImportCheckResponse,
    DepartmentImportCheckRow,
    DepartmentImportIssue,
    DepartmentImportRequest,
    DepartmentImportResponse,
    DepartmentListResponse,
    DepartmentResponse,
    DepartmentRow,
    DepartmentSaleRow,
    DepartmentTotalRow,
    DepartmentUpdateRequest,
    DepartmentWriteRequest,
    RegisterCloseRow,
    RegisterCloseWriteRequest,
)
from api.Modules.StoreBook.Services import (
    DayLockedError,
    assert_day_writable,
)
from api.Modules.DayClose.Services import (
    DayCloseNotFoundError,
    DayCloseStateError,
    create_department,
    day_summary,
    delete_register_close,
    list_departments,
    pos_codes_by_department,
    update_department,
    upsert_register_close,
)
from api.Modules.DayClose.Services.modisoft_departments import (
    ImportFileError,
    PlannedRow,
    apply_rows,
    check_file,
)

router = APIRouter(prefix="/dayclose", tags=["dayclose"])


def _department_row(d: Department, pos_codes: list[str]) -> DepartmentRow:
    return DepartmentRow(
        id=d.id, name=d.name or "",
        sort_order=int(d.sort_order or 0),
        is_active=bool(d.is_active),
        parent_id=d.parent_id,
        parent_name=(d.parent.name or "") if d.parent else "",
        department_type=d.department_type or "merchandise",
        is_taxable=bool(d.is_taxable),
        tax_rate=float(d.tax_rate) if d.tax_rate else None,
        min_age=int(d.min_age) if d.min_age else None,
        nacs_code=d.nacs_code or "",
        pos_codes=pos_codes,
    )


def _one_department_row(db: Session, sid: int, d: Department) -> DepartmentRow:
    return _department_row(d, pos_codes_by_department(db, sid).get(d.id, []))


def _close_row(c: RegisterClose) -> RegisterCloseRow:
    return RegisterCloseRow(
        id=c.id,
        register_label=c.register_label or "",
        shift_label=c.shift_label or "",
        gross_sales=c.gross_sales,
        sales_tax=c.sales_tax,
        cash_total=c.cash_total,
        card_total=c.card_total,
        other_total=c.other_total,
        cash_counted=c.cash_counted,
        over_short=(
            None if c.over_short_cents is None
            else to_dollars(c.over_short_cents)
        ),
        tender_variance=to_dollars(c.tender_variance_cents),
        notes=c.notes or "",
        source=c.source or "manual",
        department_sales=[
            DepartmentSaleRow(
                department_id=line.department_id,
                department_name=line.department.name or "",
                amount=line.amount,
            )
            for line in sorted(
                c.department_sales,
                key=lambda l: (
                    l.department.sort_order, l.department.name or "",
                ),
            )
        ],
    )


# ── Departments ────────────────────────────────────────────


@router.get("/departments", response_model=DepartmentListResponse)
def list_departments_route(
    include_inactive: bool = Query(False),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DepartmentListResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "day_close", "read")
    codes = pos_codes_by_department(db, sid)
    return DepartmentListResponse(
        departments=[_department_row(d, codes.get(d.id, [])) for d in list_departments(
            db, sid, include_inactive=include_inactive,
        )],
    )


@router.post("/departments", response_model=DepartmentResponse, status_code=201)
def create_department_route(
    body: DepartmentWriteRequest,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DepartmentResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "day_close", "update")
    try:
        dept = create_department(
            db, sid, name=body.name.strip(), sort_order=body.sort_order,
            parent_id=body.parent_id,
            department_type=body.department_type,
            is_taxable=body.is_taxable,
            tax_rate=body.tax_rate,
            min_age=body.min_age,
            nacs_code=body.nacs_code,
            pos_codes=body.pos_codes,
        )
    except DayCloseNotFoundError:
        raise HTTPException(
            status_code=404, detail="Parent department not found",
        )
    except DayCloseStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    row = _one_department_row(db, sid, dept)
    audit_operator(
        db, claims, action="create_department",
        target_type="department", target_id=str(dept.id),
        summary=(
            f"department {dept.name} ({row.department_type}"
            + (f", POS {', '.join(row.pos_codes)}" if row.pos_codes else "")
            + ")"
        ),
    )
    db.commit()
    return DepartmentResponse(department=row)


@router.put("/departments/{department_id}", response_model=DepartmentResponse)
def update_department_route(
    department_id: int = Path(..., ge=1),
    body: DepartmentUpdateRequest = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DepartmentResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "day_close", "update")
    try:
        dept = update_department(
            db, sid, department_id,
            name=body.name.strip() if body.name is not None else None,
            sort_order=body.sort_order,
            is_active=body.is_active,
            parent_id=body.parent_id,
            department_type=body.department_type,
            is_taxable=body.is_taxable,
            tax_rate=body.tax_rate,
            min_age=body.min_age,
            nacs_code=body.nacs_code,
            pos_codes=body.pos_codes,
        )
    except DayCloseNotFoundError:
        raise HTTPException(status_code=404, detail="Department not found")
    except DayCloseStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    row = _one_department_row(db, sid, dept)
    audit_operator(
        db, claims, action="update_department",
        target_type="department", target_id=str(dept.id),
        summary=f"department {dept.name} updated",
    )
    db.commit()
    return DepartmentResponse(department=row)


# ── Modisoft department import ─────────────────────────────


def _check_row(p: PlannedRow) -> DepartmentImportCheckRow:
    r = p.row
    return DepartmentImportCheckRow(
        line=r.line, name=r.name, pos_code=r.pos_code,
        modisoft_type=r.modisoft_type,
        type_group=r.group,
        department_type=p.department_type,
        type_sure=p.type_sure,
        is_taxable=r.is_taxable, tax_rate=r.tax_rate, min_age=r.min_age,
        nacs_code=r.nacs_code, items=r.items,
        status=p.status,
        existing_id=p.existing_id, existing_name=p.existing_name,
        existing_type=p.existing_type,
        changes=p.changes,
        problem=p.problem,
        problem_name=p.problem_name,
        unused=p.unused, include=p.include,
    )


@router.post(
    "/departments/import/modisoft/check",
    response_model=DepartmentImportCheckResponse,
)
def check_department_import_route(
    body: DepartmentImportCheckRequest,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DepartmentImportCheckResponse:
    """Read a Modisoft departments export and plan every row against
    the store's departments. Writes nothing."""
    sid = resolve_store_scope(claims)
    require_permission(claims, "day_close", "update")
    data = decode_base64(
        body.content_base64, detail="Could not read the uploaded file.",
    )
    try:
        report = check_file(db, sid, data)
    except ImportFileError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    finally:
        db.rollback()
    return DepartmentImportCheckResponse(
        rows=[_check_row(p) for p in report.rows],
        columns_used=report.columns_used,
        columns_ignored=report.columns_ignored,
        issues=[
            DepartmentImportIssue(
                code=code,
                count=issue.count, lines=issue.lines,
            )
            for code, issue in report.issues.items()
        ],
    )


@router.post(
    "/departments/import/modisoft", response_model=DepartmentImportResponse,
)
def import_departments_route(
    body: DepartmentImportRequest,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DepartmentImportResponse:
    """Create or update the rows the person kept after the check, each
    with the type they chose. All or nothing: one refused row (a
    register number another department holds, a name taken) is a 409
    and nothing is saved."""
    sid = resolve_store_scope(claims)
    require_permission(claims, "day_close", "update")
    try:
        result = apply_rows(db, sid, [r.model_dump() for r in body.rows])
    except DayCloseStateError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc))
    audit_operator(
        db, claims, action="import_departments",
        target_type="department", target_id=str(sid),
        summary=(
            f"Modisoft departments: {result.created} new, "
            f"{result.updated} updated, {result.unchanged} unchanged"
        ),
    )
    db.commit()
    return DepartmentImportResponse(
        created=result.created, updated=result.updated,
        unchanged=result.unchanged,
    )


# ── Day close ──────────────────────────────────────────────


def _summary_response(
    db: Session, sid: int, day: date,
) -> DayCloseSummaryResponse:
    summary = day_summary(db, sid, day)
    return DayCloseSummaryResponse(
        date=day.isoformat(),
        closes=[_close_row(c) for c in summary.closes],
        department_totals=[
            DepartmentTotalRow(
                department_id=t.department.id,
                department_name=t.department.name or "",
                amount=to_dollars(t.amount_cents),
            )
            for t in summary.department_totals
        ],
        gross_sales=to_dollars(summary.gross_sales_cents),
        sales_tax=to_dollars(summary.sales_tax_cents),
        cash_total=to_dollars(summary.cash_total_cents),
        card_total=to_dollars(summary.card_total_cents),
        other_total=to_dollars(summary.other_total_cents),
        over_short=(
            None if summary.over_short_cents is None
            else to_dollars(summary.over_short_cents)
        ),
        tender_variance=to_dollars(summary.tender_variance_cents),
        uncounted_drawers=summary.uncounted_drawers,
    )


def _refuse_locked_day(db: Session, store_id: int, d: date) -> None:
    """A locked store daily book is view only: a cashier can't add,
    replace or remove a register close on it until the day is
    unlocked. Same 409 as the store daily book's own edits. (POS
    imports still land on a locked day — StoreBook ``apply_import``.)"""
    try:
        assert_day_writable(db, store_id, d)
    except DayLockedError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/day/{day}", response_model=DayCloseSummaryResponse)
def day_summary_route(
    day: str = Path(..., min_length=10, max_length=10),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DayCloseSummaryResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "day_close", "read")
    return _summary_response(db, sid, parse_iso_day(day, field="day"))


@router.post("/day/{day}/closes", response_model=DayCloseSummaryResponse)
def upsert_close_route(
    day: str = Path(..., min_length=10, max_length=10),
    body: RegisterCloseWriteRequest = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DayCloseSummaryResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "day_close", "create")
    d = parse_iso_day(day, field="day")
    _refuse_locked_day(db, sid, d)
    lines = {l.department_id: l.amount for l in body.department_sales}
    if len(lines) != len(body.department_sales):
        raise HTTPException(
            status_code=422,
            detail="Each department may appear only once.",
        )
    try:
        row = upsert_register_close(
            db, sid, d,
            register_label=body.register_label,
            shift_label=body.shift_label,
            gross_sales=body.gross_sales,
            sales_tax=body.sales_tax,
            cash_total=body.cash_total,
            card_total=body.card_total,
            other_total=body.other_total,
            cash_counted=body.cash_counted,
            notes=body.notes,
            department_sales=lines,
            created_by=int(claims["sub"]),
        )
    except DayCloseNotFoundError:
        raise HTTPException(status_code=404, detail="Department not found")
    except DayCloseStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    audit_operator(
        db, claims, action="upsert_register_close",
        target_type="register_close", target_id=str(row.id),
        summary=f"{d.isoformat()} {row.register_label}"
                f"{' / ' + row.shift_label if row.shift_label else ''} "
                f"gross ${row.gross_sales:,.2f}",
    )
    db.commit()
    return _summary_response(db, sid, d)


@router.delete("/closes/{close_id}", response_model=DayCloseSummaryResponse)
def delete_close_route(
    close_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DayCloseSummaryResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "day_close", "update")
    existing = db.get(RegisterClose, close_id)
    if existing is not None and existing.store_id == sid:
        _refuse_locked_day(db, sid, existing.report_date)
    try:
        row = delete_register_close(db, sid, close_id)
    except DayCloseNotFoundError:
        raise HTTPException(
            status_code=404, detail="Register close not found",
        )
    d = row.report_date
    audit_operator(
        db, claims, action="delete_register_close",
        target_type="register_close", target_id=str(close_id),
        summary=f"{d.isoformat()} {row.register_label}"
                f"{' / ' + row.shift_label if row.shift_label else ''}",
    )
    db.commit()
    return _summary_response(db, sid, d)
