"""Check cashing — Controllers (FastAPI router).

Mounts at ``/api/v2/check-cashing/*``:

  GET  /settings                           the store's fee and ID rules
  PUT  /settings                           save them (manage switch)
  GET  /customers                          paginated, live search
  POST /customers                          add a customer with their IDs
  GET  /customers/{id}                     profile
  PUT  /customers/{id}                     edit the profile
  POST /customers/{id}/ids                 add an ID
  PUT  /customers/{id}/ids/{id_id}         edit an ID
  DELETE /customers/{id}/ids/{id_id}       remove an ID (never the last)
                                           and its pictures
  GET  /companies                          paginated, live search
  POST /companies                          add a company
  GET  /companies/{id}                     profile
  PUT  /companies/{id}                     edit it

Every route needs the store's opt-in ``check_desk`` flag (403 when
off), a ``check_cashing`` right and the store's activated computer
(``require_check_device``; the activation routes live in
``Controllers/device.py``). Blocking or trusting someone and
giving them their own fee need the single switch
``check_cashing_manage.update`` (Admin by default), as do the
settings. Every change writes an operator-audit row.
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from sqlalchemy.orm import Session

from api.Core.Audit import audit_operator
from api.Core.Clock import iso, store_local_today
from api.Core.Database import get_db
from api.Core.Pagination import PaginationParams, paginate, pagination_dep
from api.Core.Sorting import SORT_DIR_PATTERN
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services.principal import (
    require_permission,
    resolve_store_scope,
)
from api.Modules.CheckCashing.Models import (
    CheckCompany, CheckCustomer, CheckCustomerId,
)
from api.Modules.CheckCashing.Requests import (
    CheckCompanyBody,
    CheckCompanyDetail,
    CheckCompanyListResponse,
    CheckCompanyResponse,
    CheckCompanyRow,
    CheckCustomerCreateBody,
    CheckCustomerDetail,
    CheckCustomerIdBody,
    CheckCustomerIdRow,
    CheckCustomerListResponse,
    CheckCustomerResponse,
    CheckCustomerRow,
    CheckCustomerUpdateBody,
    CheckSettingsBody,
    CheckSettingsResponse,
)
from api.Modules.CheckCashing.Services import (
    CheckCashingConflictError,
    CheckCashingNotFoundError,
    add_customer_id,
    companies_query,
    create_company,
    create_customer,
    customers_query,
    delete_customer_id,
    from_hundredths,
    get_company,
    get_customer,
    get_settings,
    id_expired,
    mask,
    module_enabled,
    save_settings,
    umbrella,
    update_company,
    update_customer,
    update_customer_id,
)
from api.Modules.CheckCashing.Services.device import (
    cookie_name, device_state, touch,
)
from api.Modules.CheckCashing.Services.pictures import (
    current_pictures, delete_id_pictures, picture_ids_by,
)
from api.Modules.Tenancy.Models import Store


def require_check_device(
    request: Request,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> None:
    """Check cashing answers only on the store's activated computer
    (owner, 2026-11-09). The platform superadmin is exempt (support);
    a store that has the module off gets the module's own 403."""
    if claims.get("role") == "superadmin":
        return
    try:
        sid = resolve_store_scope(claims)
    except HTTPException:
        return
    if not module_enabled(db, sid):
        return
    found = device_state(db, sid, request.cookies.get(cookie_name(sid)))
    if found.state == "this" and found.device is not None:
        if touch(db, found.device):
            db.commit()
        return
    raise HTTPException(
        status_code=403,
        detail=(
            f"Check cashing is locked to {found.device.name}. "
            "An Admin can move it to this computer."
            if found.device is not None
            else "This computer is not activated for check cashing."
        ),
    )


router = APIRouter(
    prefix="/check-cashing", tags=["check-cashing"],
    dependencies=[Depends(require_check_device)],
)

RESOURCE = "check_cashing"
MANAGE = "check_cashing_manage"
STATUS_PATTERN = "^(|normal|trusted|blocked)$"


def _scope(db: Session, claims: dict[str, Any], action: str) -> int:
    """The caller's store, once the module is on there and they hold
    ``check_cashing.<action>``."""
    sid = resolve_store_scope(claims)
    if not module_enabled(db, sid):
        raise HTTPException(
            status_code=403,
            detail="Check cashing is not turned on for this store.",
        )
    require_permission(claims, RESOURCE, action)
    return sid


def _require_manage_for(
    claims: dict[str, Any], *, status: str, fee_kind: str | None,
    fee_value: float | None,
    old_status: str = "normal", old_fee_kind: str | None = None,
    old_fee_value: float | None = None,
) -> None:
    """Blocking, trusting and an own fee are the manager's call."""
    changes = (
        status != old_status
        or fee_kind != old_fee_kind
        or (fee_value or 0) != (old_fee_value or 0)
    )
    if changes:
        require_permission(claims, MANAGE, "update")


def _store_names(db: Session, store_ids: set[int]) -> dict[int, str]:
    if not store_ids:
        return {}
    return {
        int(s.id): s.name or ""
        for s in db.query(Store).filter(Store.id.in_(store_ids))
    }


def _settings_response(data: dict[str, Any]) -> CheckSettingsResponse:
    return CheckSettingsResponse(
        default_fee_kind=data["default_fee_kind"],
        default_fee_value=from_hundredths(data["default_fee_value"]) or 0.0,
        base_charge=from_hundredths(data["base_charge_cents"]),
        base_charge_under=from_hundredths(data["base_charge_under_cents"]),
        expired_id_mode=data["expired_id_mode"],
        daily_limit=from_hundredths(data["daily_limit_cents"]),
    )


def _id_row(
    row: CheckCustomerId, today: Any, pictures: dict[str, int] | None = None,
) -> CheckCustomerIdRow:
    pics = pictures or {}
    return CheckCustomerIdRow(
        id=row.id, id_type=row.id_type, id_number=row.id_number,
        issuer=row.issuer or "", expires_on=row.expires_on,
        expired=id_expired(row, today),
        front_picture_id=pics.get("id_front"),
        back_picture_id=pics.get("id_back"),
    )


def _customer_detail(
    db: Session, row: CheckCustomer, sid: int,
) -> CheckCustomerDetail:
    today = store_local_today(db, sid)
    names = _store_names(db, {int(row.store_id)})
    pics = current_pictures(db, customer_ids=[int(row.id)])
    by_id = picture_ids_by(pics, "customer_id_doc_id")
    photo = picture_ids_by(
        [p for p in pics if p.kind == "photo"], "customer_id",
    ).get(row.id, {})
    return CheckCustomerDetail(
        id=row.id, full_name=row.full_name, dob=row.dob,
        phone_country=row.phone_country or "+1",
        phone_number=row.phone_number or "",
        address=row.address or "", status=row.status,
        status_reason=row.status_reason or "",
        fee_kind=row.fee_kind, fee_value=from_hundredths(row.fee_value),
        notes=row.notes or "",
        ids=[_id_row(i, today, by_id.get(i.id)) for i in row.ids],
        photo_picture_id=photo.get("photo"),
        home_store_name=names.get(int(row.store_id), ""),
        created_at=iso(row.created_at), updated_at=iso(row.updated_at),
    )


def _company_detail(db: Session, row: CheckCompany) -> CheckCompanyDetail:
    names = _store_names(db, {int(row.store_id)})
    return CheckCompanyDetail(
        id=row.id, name=row.name, routing_number=row.routing_number or "",
        account_number=row.account_number or "", address=row.address or "",
        phone=row.phone or "", status=row.status,
        status_reason=row.status_reason or "",
        fee_kind=row.fee_kind, fee_value=from_hundredths(row.fee_value),
        notes=row.notes or "",
        home_store_name=names.get(int(row.store_id), ""),
        created_at=iso(row.created_at), updated_at=iso(row.updated_at),
    )


def _not_found(exc: CheckCashingNotFoundError) -> HTTPException:
    return HTTPException(status_code=404, detail=str(exc))


def _conflict(exc: CheckCashingConflictError) -> HTTPException:
    return HTTPException(status_code=409, detail=str(exc))


# ── Settings ───────────────────────────────────────────────


@router.get("/settings", response_model=CheckSettingsResponse)
def get_settings_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckSettingsResponse:
    sid = _scope(db, claims, "read")
    return _settings_response(get_settings(db, sid))


@router.put("/settings", response_model=CheckSettingsResponse)
def save_settings_route(
    body: CheckSettingsBody,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckSettingsResponse:
    sid = _scope(db, claims, "read")
    require_permission(claims, MANAGE, "update")
    data = save_settings(db, sid, body.model_dump(), int(claims["sub"]))
    audit_operator(
        db, claims, action="update_check_cashing_settings",
        target_type="check_cashing_settings", target_id=str(sid),
        summary=(
            f"default fee {body.default_fee_kind} {body.default_fee_value:g}, "
            f"expired ID {body.expired_id_mode}"
        ),
    )
    db.commit()
    return _settings_response(data)


# ── Customers ──────────────────────────────────────────────


@router.get("/customers", response_model=CheckCustomerListResponse)
def list_customers_route(
    q: str = Query("", max_length=120),
    status: str = Query("", pattern=STATUS_PATTERN),
    sort: str = Query("", description="name, created or status; empty = name A→Z."),
    dir: str = Query("asc", pattern=SORT_DIR_PATTERN),
    pagination: PaginationParams = Depends(pagination_dep),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCustomerListResponse:
    sid = _scope(db, claims, "read")
    stores = umbrella(db, sid)
    query = customers_query(
        db, stores, q=q, status=status, sort=sort, direction=dir,
    )
    payload = paginate(query, pagination)
    rows: list[CheckCustomer] = payload["rows"]
    today = store_local_today(db, sid)
    names = _store_names(db, {int(r.store_id) for r in rows})
    return CheckCustomerListResponse(
        rows=[
            CheckCustomerRow(
                id=r.id, full_name=r.full_name,
                phone_country=r.phone_country or "+1",
                phone_number=r.phone_number or "",
                status=r.status,
                id_summary=mask(r.ids[0].id_number) if r.ids else "",
                has_expired_id=any(id_expired(i, today) for i in r.ids),
                home_store_name=names.get(int(r.store_id), ""),
                created_at=iso(r.created_at),
            )
            for r in rows
        ],
        total=payload["total"], page=payload["page"],
        total_pages=payload["total_pages"],
    )


@router.post("/customers", response_model=CheckCustomerResponse, status_code=201)
def create_customer_route(
    body: CheckCustomerCreateBody,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCustomerResponse:
    sid = _scope(db, claims, "create")
    _require_manage_for(
        claims, status=body.status, fee_kind=body.fee_kind,
        fee_value=body.fee_value,
    )
    row = create_customer(db, sid, body.model_dump(), int(claims["sub"]))
    audit_operator(
        db, claims, action="create_check_customer",
        target_type="check_customer", target_id=str(row.id),
        target_label=row.full_name,
        summary=f"{len(row.ids)} ID(s), status {row.status}",
    )
    db.commit()
    return CheckCustomerResponse(customer=_customer_detail(db, row, sid))


@router.get("/customers/{customer_id}", response_model=CheckCustomerResponse)
def get_customer_route(
    customer_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCustomerResponse:
    sid = _scope(db, claims, "read")
    try:
        row = get_customer(db, umbrella(db, sid), customer_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    return CheckCustomerResponse(customer=_customer_detail(db, row, sid))


@router.put("/customers/{customer_id}", response_model=CheckCustomerResponse)
def update_customer_route(
    customer_id: int = Path(..., ge=1),
    body: CheckCustomerUpdateBody = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCustomerResponse:
    sid = _scope(db, claims, "update")
    stores = umbrella(db, sid)
    try:
        existing = get_customer(db, stores, customer_id)
        _require_manage_for(
            claims, status=body.status, fee_kind=body.fee_kind,
            fee_value=body.fee_value, old_status=existing.status,
            old_fee_kind=existing.fee_kind,
            old_fee_value=from_hundredths(existing.fee_value),
        )
        old_status = existing.status
        row = update_customer(db, stores, customer_id, body.model_dump())
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    action = "update_check_customer"
    summary = "profile updated"
    if row.status != old_status:
        action = {
            "blocked": "block_check_customer",
            "trusted": "trust_check_customer",
        }.get(row.status, "unblock_check_customer")
        summary = f"status {old_status} → {row.status}"
        if row.status_reason:
            summary += f": {row.status_reason}"
    audit_operator(
        db, claims, action=action, target_type="check_customer",
        target_id=str(row.id), target_label=row.full_name, summary=summary,
    )
    db.commit()
    return CheckCustomerResponse(customer=_customer_detail(db, row, sid))


@router.post(
    "/customers/{customer_id}/ids", response_model=CheckCustomerResponse,
    status_code=201,
)
def add_customer_id_route(
    customer_id: int = Path(..., ge=1),
    body: CheckCustomerIdBody = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCustomerResponse:
    sid = _scope(db, claims, "update")
    stores = umbrella(db, sid)
    try:
        id_row = add_customer_id(db, stores, customer_id, body.model_dump())
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    customer = id_row.customer
    audit_operator(
        db, claims, action="add_check_customer_id",
        target_type="check_customer", target_id=str(customer.id),
        target_label=customer.full_name,
        summary=f"{id_row.id_type} {mask(id_row.id_number)}",
    )
    db.commit()
    return CheckCustomerResponse(customer=_customer_detail(db, customer, sid))


@router.put(
    "/customers/{customer_id}/ids/{id_row_id}", response_model=CheckCustomerResponse,
)
def update_customer_id_route(
    customer_id: int = Path(..., ge=1),
    id_row_id: int = Path(..., ge=1),
    body: CheckCustomerIdBody = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCustomerResponse:
    sid = _scope(db, claims, "update")
    stores = umbrella(db, sid)
    try:
        id_row = update_customer_id(
            db, stores, customer_id, id_row_id, body.model_dump(),
        )
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    customer = id_row.customer
    audit_operator(
        db, claims, action="update_check_customer_id",
        target_type="check_customer", target_id=str(customer.id),
        target_label=customer.full_name,
        summary=f"{id_row.id_type} {mask(id_row.id_number)}",
    )
    db.commit()
    return CheckCustomerResponse(customer=_customer_detail(db, customer, sid))


@router.delete(
    "/customers/{customer_id}/ids/{id_row_id}", response_model=CheckCustomerResponse,
)
def delete_customer_id_route(
    customer_id: int = Path(..., ge=1),
    id_row_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCustomerResponse:
    sid = _scope(db, claims, "update")
    stores = umbrella(db, sid)
    try:
        id_row = delete_customer_id(db, stores, customer_id, id_row_id)
        delete_id_pictures(db, id_row_id)
        customer = get_customer(db, stores, customer_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    audit_operator(
        db, claims, action="delete_check_customer_id",
        target_type="check_customer", target_id=str(customer.id),
        target_label=customer.full_name,
        summary=f"{id_row.id_type} {mask(id_row.id_number)}",
    )
    db.commit()
    return CheckCustomerResponse(customer=_customer_detail(db, customer, sid))


# ── Companies ──────────────────────────────────────────────


@router.get("/companies", response_model=CheckCompanyListResponse)
def list_companies_route(
    q: str = Query("", max_length=160),
    status: str = Query("", pattern=STATUS_PATTERN),
    sort: str = Query("", description="name, created or status; empty = name A→Z."),
    dir: str = Query("asc", pattern=SORT_DIR_PATTERN),
    pagination: PaginationParams = Depends(pagination_dep),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCompanyListResponse:
    sid = _scope(db, claims, "read")
    query = companies_query(
        db, umbrella(db, sid), q=q, status=status, sort=sort, direction=dir,
    )
    payload = paginate(query, pagination)
    rows: list[CheckCompany] = payload["rows"]
    names = _store_names(db, {int(r.store_id) for r in rows})
    return CheckCompanyListResponse(
        rows=[
            CheckCompanyRow(
                id=r.id, name=r.name, routing_number=r.routing_number or "",
                account_last4=(r.account_number or "")[-4:],
                phone=r.phone or "", status=r.status,
                home_store_name=names.get(int(r.store_id), ""),
                created_at=iso(r.created_at),
            )
            for r in rows
        ],
        total=payload["total"], page=payload["page"],
        total_pages=payload["total_pages"],
    )


@router.post("/companies", response_model=CheckCompanyResponse, status_code=201)
def create_company_route(
    body: CheckCompanyBody,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCompanyResponse:
    sid = _scope(db, claims, "create")
    _require_manage_for(
        claims, status=body.status, fee_kind=body.fee_kind,
        fee_value=body.fee_value,
    )
    try:
        row = create_company(
            db, sid, umbrella(db, sid), body.model_dump(), int(claims["sub"]),
        )
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    audit_operator(
        db, claims, action="create_check_company",
        target_type="check_company", target_id=str(row.id),
        target_label=row.name, summary=f"status {row.status}",
    )
    db.commit()
    return CheckCompanyResponse(company=_company_detail(db, row))


@router.get("/companies/{company_id}", response_model=CheckCompanyResponse)
def get_company_route(
    company_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCompanyResponse:
    sid = _scope(db, claims, "read")
    try:
        row = get_company(db, umbrella(db, sid), company_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    return CheckCompanyResponse(company=_company_detail(db, row))


@router.put("/companies/{company_id}", response_model=CheckCompanyResponse)
def update_company_route(
    company_id: int = Path(..., ge=1),
    body: CheckCompanyBody = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckCompanyResponse:
    sid = _scope(db, claims, "update")
    stores = umbrella(db, sid)
    try:
        existing = get_company(db, stores, company_id)
        _require_manage_for(
            claims, status=body.status, fee_kind=body.fee_kind,
            fee_value=body.fee_value, old_status=existing.status,
            old_fee_kind=existing.fee_kind,
            old_fee_value=from_hundredths(existing.fee_value),
        )
        old_status = existing.status
        row = update_company(db, stores, company_id, body.model_dump())
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    action = "update_check_company"
    summary = "profile updated"
    if row.status != old_status:
        action = {
            "blocked": "block_check_company",
            "trusted": "trust_check_company",
        }.get(row.status, "unblock_check_company")
        summary = f"status {old_status} → {row.status}"
        if row.status_reason:
            summary += f": {row.status_reason}"
    audit_operator(
        db, claims, action=action, target_type="check_company",
        target_id=str(row.id), target_label=row.name, summary=summary,
    )
    db.commit()
    return CheckCompanyResponse(company=_company_detail(db, row))
