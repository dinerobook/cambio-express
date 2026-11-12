"""Check cashing — Bad checks (FastAPI router).

Mounts at ``/api/v2/check-cashing/*`` beside Cash a check:

  GET  /bad-checks                     paginated, by status, live search
  GET  /bad-checks/{id}                one bad check, its check and paybacks
  POST /checks/{id}/bad-check          the bank sent this cashed check back
  POST /bad-checks/{id}/payments       the customer paid some back
  POST /bad-checks/{id}/write-off      a manager gives up on the rest

Same gate as every check cashing route (``check_desk`` flag, the
activated computer, a ``check_cashing`` right). Reporting one and
writing one off need ``check_cashing_manage.update``; a payback needs
``check_cashing.create``. Rules: ``INVARIANTS.md`` ("Bad checks").
"""
from typing import Any

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.orm import Session

from api.Core.Audit import audit_operator
from api.Core.Clock import iso, store_local_today
from api.Core.Database import get_db
from api.Core.Pagination import PaginationParams, paginate, pagination_dep
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services.principal import has_permission, require_permission
from api.Modules.CheckCashing.Controllers import (
    MANAGE, RESOURCE, _conflict, _not_found, _scope, _store_names,
    require_check_device,
)
from api.Modules.CheckCashing.Controllers.checks import _cents, _dollars, _rows
from api.Modules.CheckCashing.Models import BadCheck
from api.Modules.CheckCashing.Requests import (
    BadCheckDetailResponse,
    BadCheckListResponse,
    BadCheckPaymentBody,
    BadCheckPaymentRow,
    BadCheckRow,
    ReportBadCheckBody,
    WriteOffBadCheckBody,
)
from api.Modules.CheckCashing.Services import (
    CheckCashingConflictError, CheckCashingNotFoundError, umbrella,
)
from api.Modules.CheckCashing.Services.bad_checks import (
    add_payment, balance, get_bad_check, list_query, open_bad_checks, report,
    write_off,
)
from api.Modules.Tenancy.Models import User

router = APIRouter(
    prefix="/check-cashing", tags=["check-cashing"],
    dependencies=[Depends(require_check_device)],
)

STATUS_PATTERN = "^(|open|paid|written_off)$"


def _bad_rows(db: Session, rows: list[BadCheck]) -> list[BadCheckRow]:
    stores = _store_names(db, {int(r.store_id) for r in rows})
    return [
        BadCheckRow(
            id=r.id, store_name=stores.get(int(r.store_id), ""),
            cashed_check_id=r.cashed_check_id, cashed_on=r.check.store_day,
            customer_id=r.check.customer_id,
            customer_name=r.check.customer.full_name if r.check.customer else "",
            company_id=r.check.company_id,
            company_name=r.check.company.name if r.check.company else "",
            check_number=r.check.check_number or "",
            amount=_dollars(r.check.amount_cents),
            reason=r.reason,  # type: ignore[arg-type]
            returned_on=r.returned_on, fee=_dollars(r.fee_cents),
            owed=_dollars(r.owed_cents), paid=_dollars(r.paid_cents),
            balance=_dollars(balance(r)),
            status=r.status,  # type: ignore[arg-type]
            note=r.note or "", write_off_note=r.write_off_note or "",
            created_at=iso(r.created_at),
        )
        for r in rows
    ]


def _detail(
    db: Session, claims: dict[str, Any], sid: int, row: BadCheck,
) -> BadCheckDetailResponse:
    payments = list(row.payments)
    stores = _store_names(db, {int(p.store_id) for p in payments})
    user_ids = {int(p.created_by) for p in payments if p.created_by}
    users = {
        int(u.id): (u.full_name or u.username or "")
        for u in db.query(User).filter(User.id.in_(user_ids))
    } if user_ids else {}
    is_open = row.status == "open"
    return BadCheckDetailResponse(
        bad_check=_bad_rows(db, [row])[0],
        check=_rows(db, claims, sid, [row.check])[0],
        payments=[
            BadCheckPaymentRow(
                id=p.id, paid_on=p.paid_on, amount=_dollars(p.amount_cents),
                note=p.note or "", store_name=stores.get(int(p.store_id), ""),
                taken_by=users.get(int(p.created_by or 0), ""),
            )
            for p in payments
        ],
        can_pay=is_open and has_permission(claims, RESOURCE, "create"),
        can_write_off=is_open and has_permission(claims, MANAGE, "update"),
    )


def _label(row: BadCheck) -> str:
    name = row.check.company.name if row.check.company else ""
    return f"{name} #{row.check.check_number}".strip(" #")


def _who(row: BadCheck) -> str:
    return row.check.customer.full_name if row.check.customer else ""


@router.get("/bad-checks", response_model=BadCheckListResponse)
def list_bad_checks_route(
    status: str = Query("", pattern=STATUS_PATTERN),
    q: str = Query("", max_length=120),
    pagination: PaginationParams = Depends(pagination_dep),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BadCheckListResponse:
    """Bad checks of every store of the owner (a customer may pay back
    at any of them)."""
    sid = _scope(db, claims, "read")
    stores = umbrella(db, sid)
    payload = paginate(list_query(db, stores, status=status, q=q), pagination)
    still_open = open_bad_checks(db, stores)
    return BadCheckListResponse(
        rows=_bad_rows(db, payload["rows"]),
        total=payload["total"], page=payload["page"],
        total_pages=payload["total_pages"],
        open_count=still_open.count, open_owed=_dollars(still_open.owed_cents),
    )


@router.get("/bad-checks/{bad_check_id}", response_model=BadCheckDetailResponse)
def get_bad_check_route(
    bad_check_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BadCheckDetailResponse:
    sid = _scope(db, claims, "read")
    try:
        row = get_bad_check(db, umbrella(db, sid), bad_check_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    return _detail(db, claims, sid, row)


@router.post(
    "/checks/{check_id}/bad-check", response_model=BadCheckDetailResponse,
    status_code=201,
)
def report_bad_check_route(
    check_id: int = Path(..., ge=1),
    body: ReportBadCheckBody = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BadCheckDetailResponse:
    sid = _scope(db, claims, "read")
    require_permission(claims, MANAGE, "update")
    try:
        row = report(
            db, sid, check_id, user_id=int(claims["sub"]), reason=body.reason,
            returned_on=body.returned_on, fee_cents=_cents(body.fee),
            note=body.note, today=store_local_today(db, sid),
        )
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    summary = f"{_who(row)}: ${_dollars(row.owed_cents):,.2f} owed ({row.reason}"
    if row.fee_cents:
        summary += f", fee ${_dollars(row.fee_cents):,.2f}"
    summary += ")"
    audit_operator(
        db, claims, action="report_bad_check", target_type="bad_check",
        target_id=str(row.id), target_label=_label(row), summary=summary,
    )
    db.commit()
    return _detail(db, claims, sid, row)


@router.post(
    "/bad-checks/{bad_check_id}/payments", response_model=BadCheckDetailResponse,
    status_code=201,
)
def add_bad_check_payment_route(
    bad_check_id: int = Path(..., ge=1),
    body: BadCheckPaymentBody = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BadCheckDetailResponse:
    sid = _scope(db, claims, "create")
    try:
        row, payment = add_payment(
            db, sid, umbrella(db, sid), bad_check_id,
            user_id=int(claims["sub"]), amount_cents=_cents(body.amount),
            note=body.note, today=store_local_today(db, sid),
        )
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    summary = (
        f"{_who(row)}: paid ${_dollars(payment.amount_cents):,.2f}, "
        f"${_dollars(balance(row)):,.2f} left"
    )
    audit_operator(
        db, claims, action="add_bad_check_payment", target_type="bad_check",
        target_id=str(row.id), target_label=_label(row), summary=summary,
    )
    db.commit()
    return _detail(db, claims, sid, row)


@router.post(
    "/bad-checks/{bad_check_id}/write-off", response_model=BadCheckDetailResponse,
)
def write_off_bad_check_route(
    bad_check_id: int = Path(..., ge=1),
    body: WriteOffBadCheckBody = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BadCheckDetailResponse:
    sid = _scope(db, claims, "read")
    require_permission(claims, MANAGE, "update")
    try:
        row = write_off(
            db, umbrella(db, sid), bad_check_id, user_id=int(claims["sub"]),
            note=body.note,
        )
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    audit_operator(
        db, claims, action="write_off_bad_check", target_type="bad_check",
        target_id=str(row.id), target_label=_label(row),
        summary=(
            f"{_who(row)}: ${_dollars(balance(row)):,.2f} written off: "
            f"{row.write_off_note}"
        ),
    )
    db.commit()
    return _detail(db, claims, sid, row)
