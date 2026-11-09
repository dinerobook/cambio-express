"""Check cashing — Cash a check (FastAPI router).

Mounts at ``/api/v2/check-cashing/*`` beside the profile routes:

  POST /checks/review                      fee + review for what is typed (no change)
  POST /checks                             cash the check, or save "not accepted"
  GET  /checks                             paginated, by customer / company / day
  POST /checks/{id}/void                   undo a cashed check the same store day
  GET  /customers/{id}/activity            totals + recent checks
  GET  /companies/{id}/activity            totals + recent checks
  GET  /companies/{id}/customers           who cashed this company's checks
  GET  /company-lookup?routing=&account=   the company with these numbers

Same gate as the profile routes (``check_desk`` flag, a
``check_cashing`` right). Cashing or refusing needs
``check_cashing.create``; a manager approval and a void need
``check_cashing_manage.update``. Rules: ``INVARIANTS.md`` ("Cash a
check").
"""
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from api.Core.Audit import audit_operator
from api.Core.Clock import iso, store_local_today
from api.Core.Database import get_db
from api.Core.Pagination import PaginationParams, paginate, pagination_dep
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services.principal import has_permission, require_permission
from api.Modules.CheckCashing.Controllers import (
    MANAGE, _company_detail, _conflict, _not_found, _scope, _store_names,
)
from api.Modules.CheckCashing.Models import CashedCheck
from api.Modules.CheckCashing.Requests import (
    CashCheckBody,
    CashedCheckListResponse,
    CashedCheckResponse,
    CashedCheckRow,
    CheckActivityResponse,
    CheckFeeOut,
    CheckReviewBody,
    CheckReviewItemOut,
    CheckReviewResponse,
    CheckStatsOut,
    CompanyCustomerRow,
    CompanyCustomersResponse,
    CompanyLookupResponse,
    VoidCheckBody,
)
from api.Modules.CheckCashing.Services import (
    CheckCashingConflictError,
    CheckCashingNotFoundError,
    from_hundredths,
    get_company,
    get_customer,
    umbrella,
)
from api.Modules.CheckCashing.Services.cashing import (
    CashRequest,
    Review,
    Stats,
    checks_query,
    company_customers,
    find_company_by_numbers,
    get_check,
    record,
    review,
    stats,
    void,
)
from api.Modules.Tenancy.Models import User

router = APIRouter(prefix="/check-cashing", tags=["check-cashing"])

RECENT = 15


def _cents(value: float) -> int:
    return int(round(value * 100))


def _dollars(cents: int | None) -> float:
    return (cents or 0) / 100.0


def _review_response(result: Review) -> CheckReviewResponse:
    fee = result.fee
    return CheckReviewResponse(
        fee=None if fee is None else CheckFeeOut(
            kind=fee.kind, value=from_hundredths(fee.value),
            fee=_dollars(fee.cents), source=fee.source,
            base_applied=fee.base_applied,
        ),
        items=[
            CheckReviewItemOut(
                code=i.code, level=i.level,  # type: ignore[arg-type]
                count=i.count,
                amount=None if i.amount_cents is None else _dollars(i.amount_cents),
                day=i.day,
            )
            for i in result.items
        ],
        today_count=result.today_count,
        today_total=_dollars(result.today_cents),
    )


def _rows(
    db: Session, claims: dict[str, Any], sid: int, rows: list[CashedCheck],
) -> list[CashedCheckRow]:
    today = store_local_today(db, sid)
    manager = has_permission(claims, MANAGE, "update")
    stores = _store_names(db, {int(r.store_id) for r in rows})
    user_ids = {int(r.created_by) for r in rows if r.created_by}
    users = {
        int(u.id): (u.full_name or u.username or "")
        for u in db.query(User).filter(User.id.in_(user_ids))
    } if user_ids else {}
    return [
        CashedCheckRow(
            id=r.id, store_name=stores.get(int(r.store_id), ""),
            store_day=r.store_day, created_at=iso(r.created_at),
            customer_id=r.customer_id,
            customer_name=r.customer.full_name if r.customer else "",
            company_id=r.company_id,
            company_name=r.company.name if r.company else "",
            check_number=r.check_number or "", check_date=r.check_date,
            amount=_dollars(r.amount_cents), fee=_dollars(r.fee_cents),
            cash=_dollars(r.cash_cents), status=r.status,
            reason=r.reason or "", void_reason=r.void_reason or "",
            cashier_name=users.get(int(r.created_by or 0), ""),
            warnings=[w for w in (r.warnings or "").split(",") if w],
            approved=r.approved_by is not None,
            can_void=(
                manager and r.status == "cashed"
                and int(r.store_id) == sid and r.store_day == today
            ),
        )
        for r in rows
    ]


def _stats_out(scope: str, s: Stats) -> CheckStatsOut:
    return CheckStatsOut(
        scope=scope,  # type: ignore[arg-type]
        count=s.count, total=_dollars(s.total_cents),
        biggest=_dollars(s.max_cents),
        average=round(_dollars(s.total_cents) / s.count, 2) if s.count else 0.0,
        last_day=s.last_day,
        last_amount=None if s.last_cents is None else _dollars(s.last_cents),
        declined=s.declined, voided=s.voided,
    )


def _activity(
    db: Session, claims: dict[str, Any], sid: int, stores: list[int],
    **match: int,
) -> CheckActivityResponse:
    out = [_stats_out("store", stats(db, [sid], **match))]
    if len(stores) > 1:
        out.append(_stats_out("all", stats(db, stores, **match)))
    recent = (
        checks_query(db, stores).filter_by(**match)
        .order_by(CashedCheck.created_at.desc(), CashedCheck.id.desc())
        .limit(RECENT).all()
    )
    return CheckActivityResponse(stats=out, recent=_rows(db, claims, sid, recent))


# ── Review and cash ────────────────────────────────────────


@router.post("/checks/review", response_model=CheckReviewResponse)
def review_check_route(
    body: CheckReviewBody,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckReviewResponse:
    """POST only because the body is a form; nothing is saved."""
    sid = _scope(db, claims, "read")
    stores = umbrella(db, sid)
    try:
        customer = (
            get_customer(db, stores, body.customer_id) if body.customer_id else None
        )
        company = get_company(db, stores, body.company_id) if body.company_id else None
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    result = review(
        db, sid, stores, customer=customer, company=company,
        check_number=body.check_number, check_date=body.check_date,
        amount_cents=_cents(body.amount), today=store_local_today(db, sid),
    )
    return _review_response(result)


@router.post("/checks", response_model=CashedCheckResponse, status_code=201)
def cash_check_route(
    body: CashCheckBody,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CashedCheckResponse:
    sid = _scope(db, claims, "create")
    stores = umbrella(db, sid)
    try:
        customer = get_customer(db, stores, body.customer_id)
        company = get_company(db, stores, body.company_id)
        row = record(
            db, sid, stores,
            CashRequest(
                customer_id=body.customer_id, company_id=body.company_id,
                check_number=body.check_number, check_date=body.check_date,
                amount_cents=_cents(body.amount), fee_cents=_cents(body.fee),
                acknowledged=set(body.acknowledged), decision=body.decision,
                reason=body.reason, micr=body.micr,
            ),
            user_id=int(claims["sub"]),
            can_approve=has_permission(claims, MANAGE, "update"),
            today=store_local_today(db, sid),
            customer=customer, company=company,
        )
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    amount = f"${_dollars(row.amount_cents):,.2f}"
    if row.status == "declined":
        action, summary = "decline_check", f"{amount} not accepted: {row.reason}"
    else:
        action = "cash_check"
        summary = f"{amount}, fee ${_dollars(row.fee_cents):,.2f}"
        if row.fee_cents != row.fee_suggested_cents:
            summary += f" (suggested ${_dollars(row.fee_suggested_cents):,.2f})"
        if row.warnings:
            summary += f", checked {row.warnings}"
        if row.approved_by:
            summary += ", manager approved"
    audit_operator(
        db, claims, action=action, target_type="cashed_check",
        target_id=str(row.id),
        target_label=f"{company.name} #{row.check_number}".strip(" #"),
        summary=f"{customer.full_name}: {summary}",
    )
    db.commit()
    return CashedCheckResponse(check=_rows(db, claims, sid, [row])[0])


@router.get("/checks", response_model=CashedCheckListResponse)
def list_checks_route(
    customer_id: int | None = Query(None, ge=1),
    company_id: int | None = Query(None, ge=1),
    day: date | None = Query(None, description="One store day (YYYY-MM-DD)."),
    status: str = Query("", pattern="^(|cashed|declined|voided)$"),
    pagination: PaginationParams = Depends(pagination_dep),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CashedCheckListResponse:
    sid = _scope(db, claims, "read")
    query = checks_query(db, umbrella(db, sid))
    if customer_id:
        query = query.filter(CashedCheck.customer_id == customer_id)
    if company_id:
        query = query.filter(CashedCheck.company_id == company_id)
    if day:
        query = query.filter(CashedCheck.store_day == day)
    if status:
        query = query.filter(CashedCheck.status == status)
    query = query.order_by(CashedCheck.created_at.desc(), CashedCheck.id.desc())
    payload = paginate(query, pagination)
    return CashedCheckListResponse(
        rows=_rows(db, claims, sid, payload["rows"]),
        total=payload["total"], page=payload["page"],
        total_pages=payload["total_pages"],
    )


@router.post("/checks/{check_id}/void", response_model=CashedCheckResponse)
def void_check_route(
    check_id: int = Path(..., ge=1),
    body: VoidCheckBody = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CashedCheckResponse:
    sid = _scope(db, claims, "read")
    require_permission(claims, MANAGE, "update")
    try:
        row = void(
            db, sid, check_id, user_id=int(claims["sub"]), reason=body.reason,
            today=store_local_today(db, sid),
        )
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    audit_operator(
        db, claims, action="void_check", target_type="cashed_check",
        target_id=str(row.id),
        target_label=f"{row.company.name} #{row.check_number}".strip(" #"),
        summary=(
            f"{row.customer.full_name}: ${_dollars(row.amount_cents):,.2f} "
            f"voided: {row.void_reason}"
        ),
    )
    db.commit()
    return CashedCheckResponse(check=_rows(db, claims, sid, [row])[0])


# ── Profiles ───────────────────────────────────────────────


@router.get("/customers/{customer_id}/activity", response_model=CheckActivityResponse)
def customer_activity_route(
    customer_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckActivityResponse:
    sid = _scope(db, claims, "read")
    stores = umbrella(db, sid)
    try:
        get_customer(db, stores, customer_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    return _activity(db, claims, sid, stores, customer_id=customer_id)


@router.get("/companies/{company_id}/activity", response_model=CheckActivityResponse)
def company_activity_route(
    company_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckActivityResponse:
    sid = _scope(db, claims, "read")
    stores = umbrella(db, sid)
    try:
        get_company(db, stores, company_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    return _activity(db, claims, sid, stores, company_id=company_id)


@router.get(
    "/companies/{company_id}/customers", response_model=CompanyCustomersResponse,
)
def company_customers_route(
    company_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CompanyCustomersResponse:
    sid = _scope(db, claims, "read")
    stores = umbrella(db, sid)
    try:
        get_company(db, stores, company_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    return CompanyCustomersResponse(rows=[
        CompanyCustomerRow(
            id=c.id, full_name=c.full_name, status=c.status,
            checks=count, last_day=last_day,
        )
        for c, count, last_day in company_customers(db, stores, company_id)
    ])


@router.get("/company-lookup", response_model=CompanyLookupResponse)
def company_lookup_route(
    routing: str = Query("", pattern=r"^(\d{9})?$"),
    account: str = Query("", pattern=r"^\d{0,20}$"),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CompanyLookupResponse:
    """The company a scanned or typed check belongs to, if known."""
    sid = _scope(db, claims, "read")
    row = find_company_by_numbers(db, umbrella(db, sid), routing, account)
    return CompanyLookupResponse(
        company=None if row is None else _company_detail(db, row),
    )
