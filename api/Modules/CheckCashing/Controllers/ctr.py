"""Check cashing — Currency Transaction Reports (FastAPI router).

Mounts at ``/api/v2/check-cashing/*``:

  GET  /ctrs                           paginated, by status, soonest due first
  GET  /ctrs/{id}                      one report, every field FinCEN asks for
  POST /ctrs/{id}/file                 save FinCEN's BSA ID (locks it)
  PUT  /customers/{id}/ctr-details     the customer's CTR details (counter)
  POST /customers/{id}/reveal-tin      the whole SSN / ITIN (audited)

Same gate as every check cashing route (``check_desk`` flag, the
activated computer, a ``check_cashing`` right). The reports, filing and
revealing a number are the manager's (``check_cashing_manage.update``);
the counter fills a customer's details with ``check_cashing.update``.
Rules: ``INVARIANTS.md`` ("CTR").
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from api.Core.Audit import audit_operator
from api.Core.Clock import iso, store_local_today
from api.Core.Database import get_db
from api.Core.Pagination import PaginationParams, paginate, pagination_dep
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services.principal import require_permission
from api.Modules.CheckCashing.Controllers import (
    MANAGE, _conflict, _customer_detail, _not_found, _scope, _store_names,
    require_check_device,
)
from api.Modules.CheckCashing.Controllers.checks import _dollars
from api.Modules.CheckCashing.Models import CheckCustomer, CtrReport
from api.Modules.CheckCashing.Requests import (
    CheckCtrCheckRow,
    CheckCtrCounts,
    CheckCtrDetail,
    CheckCtrDetailsBody,
    CheckCtrFileBody,
    CheckCtrFiler,
    CheckCtrListResponse,
    CheckCtrPerson,
    CheckCtrResponse,
    CheckCtrRow,
    CheckCustomerResponse,
    CheckTinResponse,
)
from api.Modules.CheckCashing.Services import (
    CheckCashingConflictError, CheckCashingNotFoundError, get_customer,
    get_settings, id_expired, umbrella,
)
from api.Modules.CheckCashing.Services import ctr
from api.Modules.CheckCashing.Services.pii import (
    PiiKeyMissing, decrypt, encrypt, mask_tin,
)
from api.Modules.Tenancy.Models import Store, User

router = APIRouter(
    prefix="/check-cashing", tags=["check-cashing"],
    dependencies=[Depends(require_check_device)],
)

STATUS_PATTERN = "^(|to_file|filed|not_needed)$"
# The store settings a CTR needs (Part III and the location).
FILER_FIELDS = ("legal_name", "ein", "street", "city", "state", "zip_code")


def _manager_scope(db: Session, claims: dict[str, Any]) -> int:
    sid = _scope(db, claims, "read")
    require_permission(claims, MANAGE, "update")
    return sid


def _rows(db: Session, rows: list[CtrReport], today: Any) -> list[CheckCtrRow]:
    stores = _store_names(db, {int(r.store_id) for r in rows})
    return [
        CheckCtrRow(
            id=r.id, customer_id=r.customer_id,
            customer_name=r.customer.full_name if r.customer else "",
            store_day=r.store_day, kind=r.kind, cash=_dollars(r.cash_cents),
            check_count=r.check_count, status=r.status, due_on=r.due_on,
            overdue=r.status == "to_file" and r.due_on < today,
            bsa_id=r.bsa_id or "", filed_on=r.filed_on,
            store_name=stores.get(int(r.store_id), ""),
        )
        for r in rows
    ]


@router.get("/ctrs", response_model=CheckCtrListResponse)
def list_ctrs_route(
    status: str = Query("", pattern=STATUS_PATTERN),
    q: str = Query("", max_length=120),
    pagination: PaginationParams = Depends(pagination_dep),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCtrListResponse:
    sid = _manager_scope(db, claims)
    stores = umbrella(db, sid)
    today = store_local_today(db, sid)
    payload = paginate(ctr.list_query(db, stores, status=status, q=q), pagination)
    c = ctr.counts(db, stores, today)
    return CheckCtrListResponse(
        rows=_rows(db, payload["rows"], today),
        total=payload["total"], page=payload["page"],
        total_pages=payload["total_pages"],
        counts=CheckCtrCounts(to_file=c.to_file, overdue=c.overdue, due_soon=c.due_soon),
    )


def _filer(db: Session, store_id: int) -> CheckCtrFiler:
    settings = get_settings(db, store_id)
    store = db.get(Store, store_id)
    return CheckCtrFiler(
        legal_name=settings["legal_name"], dba_name=store.name if store else "",
        ein=settings["ein"], street=settings["street"], city=settings["city"],
        state=settings["state"], zip_code=settings["zip_code"],
        contact_name=settings["contact_name"],
        contact_phone=settings["contact_phone"],
        msb_registration=settings["msb_registration"],
        missing=[f for f in FILER_FIELDS if not settings[f]],
    )


def _person(customer: CheckCustomer, today: Any) -> CheckCtrPerson:
    ids = sorted(customer.ids, key=lambda i: (id_expired(i, today), i.id))
    doc = ids[0] if ids else None
    return CheckCtrPerson(
        full_name=customer.full_name, dob=customer.dob,
        tin_type=customer.tin_type or "",
        tin_masked=mask_tin(customer.tin_last4 or ""),
        occupation=customer.occupation or "", address=customer.address or "",
        city=customer.city or "", state=customer.state or "",
        zip_code=customer.zip_code or "", country=customer.country or "US",
        gender=customer.gender or "",
        phone=f"{customer.phone_country or ''}{customer.phone_number or ''}"
        if customer.phone_number else "",
        id_type=doc.id_type if doc else "", id_number=doc.id_number if doc else "",
        id_issuer=(doc.issuer or "") if doc else "",
        missing=ctr.details_missing(customer),
    )


def _detail(db: Session, row: CtrReport, today: Any) -> CheckCtrDetail:
    checks = ctr.report_checks(db, row)
    stores = _store_names(db, {int(c.store_id) for c in checks})
    filed_by = db.get(User, row.filed_by) if row.filed_by else None
    return CheckCtrDetail(
        row=_rows(db, [row], today)[0],
        filer=_filer(db, int(row.store_id)),
        person=_person(row.customer, today),
        checks=[
            CheckCtrCheckRow(
                id=c.id, store_name=stores.get(int(c.store_id), ""),
                company_name=c.company.name if c.company else "",
                check_number=c.check_number or "",
                amount=_dollars(c.amount_cents), fee=_dollars(c.fee_cents),
                cash=_dollars(c.cash_cents), created_at=iso(c.created_at),
            )
            for c in checks
        ],
        gto_mark=ctr.GTO_MARK if row.kind == "gto" else "",
        filed_by=(filed_by.full_name or filed_by.username or "") if filed_by else "",
    )


@router.get("/ctrs/{ctr_id}", response_model=CheckCtrResponse)
def get_ctr_route(
    ctr_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCtrResponse:
    sid = _manager_scope(db, claims)
    try:
        row = ctr.get(db, umbrella(db, sid), ctr_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    return CheckCtrResponse(ctr=_detail(db, row, store_local_today(db, sid)))


@router.post("/ctrs/{ctr_id}/file", response_model=CheckCtrResponse)
def file_ctr_route(
    ctr_id: int = Path(..., ge=1),
    body: CheckCtrFileBody = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCtrResponse:
    sid = _manager_scope(db, claims)
    today = store_local_today(db, sid)
    try:
        row = ctr.mark_filed(
            db, umbrella(db, sid), ctr_id, bsa_id=body.bsa_id,
            filed_on=body.filed_on, user_id=int(claims["sub"]), today=today,
        )
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    audit_operator(
        db, claims, action="file_check_ctr", target_type="check_ctr",
        target_id=str(row.id),
        target_label=row.customer.full_name if row.customer else "",
        summary=f"{row.store_day.isoformat()}, BSA ID {row.bsa_id}, filed {row.filed_on}",
    )
    db.commit()
    return CheckCtrResponse(ctr=_detail(db, row, today))


@router.put("/customers/{customer_id}/ctr-details", response_model=CheckCustomerResponse)
def save_ctr_details_route(
    customer_id: int = Path(..., ge=1),
    body: CheckCtrDetailsBody = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCustomerResponse:
    sid = _scope(db, claims, "update")
    try:
        row = get_customer(db, umbrella(db, sid), customer_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    if not body.tin and not row.tin_encrypted:
        raise HTTPException(status_code=409, detail="Enter the SSN or ITIN.")
    if body.tin:
        try:
            row.tin_encrypted = encrypt(body.tin)
        except PiiKeyMissing as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        row.tin_last4 = body.tin[-4:]
    row.tin_type = body.tin_type
    row.dob = body.dob
    row.occupation = body.occupation.strip()
    row.address = body.address.strip()
    row.city = body.city.strip()
    row.state = body.state.strip().upper()
    row.zip_code = body.zip_code.strip().upper()
    row.country = body.country
    row.gender = body.gender
    db.flush()
    audit_operator(
        db, claims, action="update_check_customer_ctr", target_type="check_customer",
        target_id=str(row.id), target_label=row.full_name,
        summary="CTR details" + (f", {row.tin_type} {mask_tin(row.tin_last4)}" if body.tin else ""),
    )
    db.commit()
    return CheckCustomerResponse(customer=_customer_detail(db, row, sid))


@router.post("/customers/{customer_id}/reveal-tin", response_model=CheckTinResponse)
def reveal_tin_route(
    customer_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckTinResponse:
    """A POST, not a GET: every look is written to the audit log."""
    sid = _manager_scope(db, claims)
    try:
        row = get_customer(db, umbrella(db, sid), customer_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    if not row.tin_encrypted:
        raise HTTPException(status_code=404, detail="No SSN or ITIN on file.")
    try:
        tin = decrypt(row.tin_encrypted)
    except PiiKeyMissing as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    audit_operator(
        db, claims, action="reveal_check_customer_tin", target_type="check_customer",
        target_id=str(row.id), target_label=row.full_name,
        summary=f"{row.tin_type} {mask_tin(row.tin_last4 or '')}",
    )
    db.commit()
    return CheckTinResponse(tin_type=row.tin_type or "", tin=tin)
