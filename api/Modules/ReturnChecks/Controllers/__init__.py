"""ReturnChecks module — Controllers (FastAPI router).

Mounts at `/api/v2/return-checks/*`. Endpoints:

  GET    /                       list (?status, ?q search, ?batch_id,
                                 ?company / ?customer grouping keys)
  GET    /tracking               returned checks grouped by company
                                 or customer (?by=company|customer)
  GET    /batches                returned batches with their totals
  POST   /batches                a batch and its checks at once
  GET    /batches/{id}           one batch and its checks
  PUT    /batches/{id}           edit a batch (its date moves its checks)
  DELETE /batches/{id}           delete an EMPTY batch
  GET    /{id}                   single-row detail
  POST   /                       create new pending check
  PUT    /{id}                   edit core fields
  DELETE /{id}                   delete a check entered by mistake
                                 (return_checks.delete; refused while
                                 it has paybacks)
  POST   /{id}/mark-loss         pending → loss
  POST   /{id}/mark-fraud        pending → fraud
  POST   /{id}/reopen            loss/fraud/recovered → pending
  GET    /{id}/payments          list payments
  POST   /{id}/payments          record an installment + auto-post
                                 to the daily book; auto-flips
                                 status to 'recovered' when the
                                 full amount is reached
  DELETE /{id}/payments/{pid}    remove an installment + its
                                 shadow DailyLineItem; reverts
                                 'recovered' → 'pending' if the
                                 total drops below the full amount
"""

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from api.Core.Clock import parse_iso_day
from api.Core.Database import get_db
from api.Core.Money import to_dollars
from api.Core.Pagination import PaginationParams, paginate, paginate_list
from api.Core.Responses import OkResponse
from api.Core.Sorting import SORT_DIR_PATTERN
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services.principal import require_permission, resolve_store_scope
from api.Modules.ReturnChecks.Repositories import (
    batches_query,
    find_batch,
    find_return_check,
    list_payments,
    return_checks_query,
)
from api.Modules.ReturnChecks.Requests import (
    ReturnCheckBatchCreateRequest,
    ReturnCheckBatchListResponse,
    ReturnCheckBatchResponse,
    ReturnCheckBatchRow,
    ReturnCheckBatchUpdateRequest,
    ReturnCheckPartyListResponse,
    ReturnCheckPartyRow,
    ReturnCheckListResponse,
    ReturnCheckPaymentResponse,
    ReturnCheckPaymentRow,
    ReturnCheckPaymentWriteRequest,
    ReturnCheckPaymentsResponse,
    ReturnCheckResponse,
    ReturnCheckRow,
    ReturnCheckWriteRequest,
)
from api.Modules.ReturnChecks.Services import (
    UNSET,
    RecordPaymentInput,
    ReturnCheckBatchNotFoundError,
    ReturnCheckNotFoundError,
    ReturnCheckPaymentNotFoundError,
    ReturnCheckStateError,
    ReturnCheckWriteInput,
    create_return_check,
    delete_payment,
    delete_return_check,
    mark_fraud,
    mark_loss,
    record_payment,
    reopen,
    update_return_check,
)
from api.Modules.ReturnChecks.Services.batches import (
    BatchWriteInput, batch_totals, create_batch, delete_batch, update_batch,
)
from api.Modules.ReturnChecks.Services.tracking import (
    TRACK_BY, TRACK_SORTS, party_totals,
)
from typing import Any


router = APIRouter()


def _audit_return_check_action(
    db: Session, *, claims: dict[str, Any], action: str,
    target_id: str, target_label: str, summary: str,
) -> None:
    """Operator-audit emitter for return-check mutations.

    CLAUDE.md invariant #7 — every mutating endpoint records an
    audit row.  Return checks are a financial-recovery surface
    (money the store is trying to claw back after a bounced check)
    so every state change deserves a paper trail.  Before this
    helper landed, the seven mutation routes silently mutated
    state without writing audit; the CLAUDE.md "employee action
    audit" claim of coverage was wrong for this module.

    target_type is "return_check" for the parent + its lifecycle
    transitions, "return_check_payment" for the installment
    record/delete pair, "return_check_batch" for a batch — keeps the
    audit feed filterable per legacy contract."""
    from api.Core.Audit import audit_operator
    if action in ("record_payment", "delete_payment"):
        target_type = "return_check_payment"
    elif action.endswith("_return_check_batch"):
        target_type = "return_check_batch"
    else:
        target_type = "return_check"
    audit_operator(
        db, claims,
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        action=action,
        summary=summary,
    )


def _row(rc) -> ReturnCheckRow:
    return ReturnCheckRow(
        id=rc.id,
        bounced_on=rc.bounced_on.isoformat() if rc.bounced_on else "",
        customer_name=rc.customer_name or "",
        company_name=rc.company_name or "",
        check_number=rc.check_number or "",
        payer_bank=rc.payer_bank or "",
        amount=float(rc.amount or 0),
        return_check_fee=float(rc.return_check_fee or 0),
        status=rc.status or "pending",
        status_changed_on=(
            rc.status_changed_on.isoformat()
            if rc.status_changed_on else ""
        ),
        notes=rc.notes or "",
        recovered_total=float(rc.recovered_total or 0),
        payment_count=len(rc.payments) if rc.payments else 0,
        batch_id=int(rc.batch_id) if rc.batch_id is not None else None,
        batch_reference=(rc.batch.reference or "") if rc.batch is not None else "",
        routing_number=rc.routing_number or "",
        account_number=rc.account_number or "",
    )


def _batch_row(batch) -> ReturnCheckBatchRow:
    totals = batch_totals(batch)
    return ReturnCheckBatchRow(
        id=batch.id,
        returned_on=batch.returned_on.isoformat() if batch.returned_on else "",
        reference=batch.reference or "",
        notes=batch.notes or "",
        check_count=totals.check_count,
        amount_total=to_dollars(totals.amount_cents),
        fee_total=to_dollars(totals.fee_cents),
        recovered_total=to_dollars(totals.recovered_cents),
        open_count=totals.open_count,
        companies=totals.companies,
    )


def _batch_label(batch) -> str:
    day = batch.returned_on.isoformat() if batch.returned_on else ""
    ref = (batch.reference or "").strip()
    return (f"{day} {ref}".strip())[:160]


_BATCH_NOT_FOUND = "Returned batch not found"


def _parse_payload(body: ReturnCheckWriteRequest) -> ReturnCheckWriteInput:
    bounced_on = parse_iso_day(body.bounced_on, field="bounced_on")
    sent = body.model_fields_set
    return ReturnCheckWriteInput(
        bounced_on=bounced_on,
        customer_name=body.customer_name,
        company_name=body.company_name,
        check_number=body.check_number,
        payer_bank=body.payer_bank,
        amount=float(body.amount or 0),
        return_check_fee=float(body.return_check_fee or 0),
        notes=body.notes,
        batch_id=body.batch_id if "batch_id" in sent else UNSET,
        routing_number=body.routing_number if "routing_number" in sent else UNSET,
        account_number=body.account_number if "account_number" in sent else UNSET,
    )


@router.get("", response_model=ReturnCheckListResponse)
def list_route(
    status: str = Query("", description="Optional filter: pending, recovered, loss, fraud"),
    q: str = Query("", max_length=120, description="Search customer, company, check number, bank or routing number."),
    batch_id: int | None = Query(None, ge=1, description="Only this batch's checks."),
    company: str = Query("", max_length=120, description="A company key from /tracking?by=company."),
    customer: str = Query("", max_length=120, description="A customer key from /tracking?by=customer."),
    sort: str = Query("", description="bounced, customer, company, check, bank, amount or status; empty = newest bounce first."),
    dir: str = Query("desc", pattern=SORT_DIR_PATTERN),
    page: int | None = Query(
        None, ge=1,
        description="1-based page. Omit for every check (the legacy shape).",
    ),
    per_page: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckListResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "read")
    query = return_checks_query(
        db, int(sid), status=status, sort=sort, direction=dir,
        q=q, batch_id=batch_id, company=company, customer=customer,
    )
    if page is None:
        rows = query.all()
        return ReturnCheckListResponse(
            rows=[_row(r) for r in rows], total=len(rows),
        )
    payload = paginate(
        query, PaginationParams(page=page, per_page=per_page), adapter=_row,
    )
    return ReturnCheckListResponse(
        rows=payload["rows"], total=payload["total"],
        page=payload["page"], total_pages=payload["total_pages"],
    )


def _optional_day(raw: str, field: str):
    return parse_iso_day(raw, field=field) if (raw or "").strip() else None


@router.get("/tracking", response_model=ReturnCheckPartyListResponse)
def tracking_route(
    by: str = Query("company", description="company or customer"),
    q: str = Query("", max_length=120, description="Search names."),
    date_from: str = Query("", alias="from", description="YYYY-MM-DD; empty = from the first check."),
    date_to: str = Query("", alias="to", description="YYYY-MM-DD; empty = up to today."),
    sort: str = Query("", description="checks, amount, owed, lost, last or name; empty = most checks first."),
    dir: str = Query("desc", pattern=SORT_DIR_PATTERN),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckPartyListResponse:
    """Returned checks grouped by company or by customer: how many,
    how much, what is still owed and what was written off."""
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "read")
    if by not in TRACK_BY:
        raise HTTPException(status_code=422, detail="by must be company or customer")
    rows = party_totals(
        db, int(sid), by=by, q=q,
        date_from=_optional_day(date_from, "from"),
        date_to=_optional_day(date_to, "to"),
        sort=sort if sort in TRACK_SORTS else "", direction=dir,
    )
    payload = paginate_list(rows, PaginationParams(page=page, per_page=per_page))
    return ReturnCheckPartyListResponse(
        rows=[
            ReturnCheckPartyRow(
                key=r.key, name=r.name, check_count=r.check_count,
                amount_total=to_dollars(r.amount_cents),
                owed_total=to_dollars(r.owed_cents),
                open_count=r.open_count, lost_count=r.lost_count,
                lost_total=to_dollars(r.lost_cents),
                last_returned_on=(
                    r.last_returned_on.isoformat() if r.last_returned_on else ""
                ),
                routing_number=r.routing_number,
            )
            for r in payload["rows"]
        ],
        total=payload["total"], page=payload["page"],
        total_pages=payload["total_pages"],
    )


@router.get("/batches", response_model=ReturnCheckBatchListResponse)
def batches_route(
    q: str = Query("", max_length=120, description="Search reference, notes, or a check's customer, company or number."),
    sort: str = Query("", description="returned or reference; empty = newest return first."),
    dir: str = Query("desc", pattern=SORT_DIR_PATTERN),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckBatchListResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "read")
    payload = paginate(
        batches_query(db, int(sid), q=q, sort=sort, direction=dir),
        PaginationParams(page=page, per_page=per_page), adapter=_batch_row,
    )
    return ReturnCheckBatchListResponse(
        rows=payload["rows"], total=payload["total"],
        page=payload["page"], total_pages=payload["total_pages"],
    )


@router.post("/batches", response_model=ReturnCheckBatchResponse, status_code=201)
def create_batch_route(
    body: ReturnCheckBatchCreateRequest,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckBatchResponse:
    """Record a batch of returned checks in one save."""
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "create")
    returned_on = parse_iso_day(body.returned_on, field="returned_on")
    payload = BatchWriteInput(
        returned_on=returned_on, reference=body.reference, notes=body.notes,
        checks=[
            ReturnCheckWriteInput(
                bounced_on=returned_on,
                customer_name=c.customer_name, company_name=c.company_name,
                check_number=c.check_number, payer_bank=c.payer_bank,
                amount=float(c.amount), return_check_fee=float(c.return_check_fee or 0),
                notes=c.notes, routing_number=c.routing_number,
                account_number=c.account_number,
            )
            for c in body.checks
        ],
    )
    user_id = int(claims["sub"])
    batch, checks = create_batch(db, store_id=sid, created_by=user_id, payload=payload)
    total = sum(float(c.amount or 0) for c in checks)
    _audit_return_check_action(
        db, claims=claims, action="create_return_check_batch",
        target_id=str(batch.id), target_label=_batch_label(batch),
        summary=f"checks={len(checks)} amount=${total:,.2f} returned_on={returned_on.isoformat()}",
    )
    for row in checks:
        _audit_return_check_action(
            db, claims=claims, action="create_return_check",
            target_id=str(row.id),
            target_label=(row.customer_name or "")[:160],
            summary=(
                f"check #{row.check_number or '?'} amount=${float(row.amount or 0):,.2f} "
                f"bounced_on={returned_on.isoformat()} batch={batch.id}"
            ),
        )
    db.commit()
    db.refresh(batch)
    return ReturnCheckBatchResponse(
        batch=_batch_row(batch), checks=[_row(c) for c in batch.checks],
    )


@router.get("/batches/{batch_id}", response_model=ReturnCheckBatchResponse)
def get_batch_route(
    batch_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckBatchResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "read")
    batch = find_batch(db, int(sid), batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail=_BATCH_NOT_FOUND)
    return ReturnCheckBatchResponse(
        batch=_batch_row(batch), checks=[_row(c) for c in batch.checks],
    )


@router.put("/batches/{batch_id}", response_model=ReturnCheckBatchResponse)
def update_batch_route(
    batch_id: int = Path(..., ge=1),
    body: ReturnCheckBatchUpdateRequest = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckBatchResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "update")
    returned_on = parse_iso_day(body.returned_on, field="returned_on")
    try:
        batch = update_batch(
            db, store_id=sid, batch_id=batch_id, returned_on=returned_on,
            reference=body.reference, notes=body.notes,
        )
    except ReturnCheckBatchNotFoundError:
        raise HTTPException(status_code=404, detail=_BATCH_NOT_FOUND)
    _audit_return_check_action(
        db, claims=claims, action="update_return_check_batch",
        target_id=str(batch.id), target_label=_batch_label(batch),
        summary=f"returned_on={returned_on.isoformat()} checks={len(batch.checks or [])}",
    )
    db.commit()
    db.refresh(batch)
    return ReturnCheckBatchResponse(
        batch=_batch_row(batch), checks=[_row(c) for c in batch.checks],
    )


@router.delete("/batches/{batch_id}", response_model=OkResponse)
def delete_batch_route(
    batch_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> OkResponse:
    """Delete an empty batch; one that still has checks is a 409."""
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "delete")
    try:
        batch = delete_batch(db, store_id=sid, batch_id=batch_id)
    except ReturnCheckBatchNotFoundError:
        raise HTTPException(status_code=404, detail=_BATCH_NOT_FOUND)
    except ReturnCheckStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    _audit_return_check_action(
        db, claims=claims, action="delete_return_check_batch",
        target_id=str(batch_id), target_label=_batch_label(batch),
        summary="empty batch deleted",
    )
    db.commit()
    return OkResponse(ok=True)


@router.get("/{rc_id}", response_model=ReturnCheckResponse)
def get_route(
    rc_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "read")
    rc = find_return_check(db, int(sid), rc_id)
    if rc is None:
        raise HTTPException(status_code=404, detail="Return check not found")
    return ReturnCheckResponse(return_check=_row(rc))


@router.post("", response_model=ReturnCheckResponse, status_code=201)
def create_route(
    body: ReturnCheckWriteRequest,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "create")
    payload = _parse_payload(body)
    user_id = int(claims["sub"])
    try:
        row = create_return_check(
            db, store_id=sid, created_by=user_id, payload=payload,
        )
    except ReturnCheckBatchNotFoundError:
        raise HTTPException(status_code=404, detail=_BATCH_NOT_FOUND)
    _audit_return_check_action(
        db, claims=claims, action="create_return_check",
        target_id=str(row.id),
        target_label=(row.customer_name or "")[:160],
        summary=(
            f"check #{row.check_number or '?'} amount=${float(row.amount or 0):,.2f} "
            f"bounced_on={row.bounced_on.isoformat() if row.bounced_on else ''}"
        ),
    )
    db.commit()
    return ReturnCheckResponse(return_check=_row(row))


@router.put("/{rc_id}", response_model=ReturnCheckResponse)
def update_route(
    rc_id: int = Path(..., ge=1),
    body: ReturnCheckWriteRequest = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "update")
    payload = _parse_payload(body)
    try:
        row = update_return_check(
            db, store_id=sid, rc_id=rc_id, payload=payload,
        )
    except ReturnCheckNotFoundError:
        raise HTTPException(status_code=404, detail="Return check not found")
    except ReturnCheckBatchNotFoundError:
        raise HTTPException(status_code=404, detail=_BATCH_NOT_FOUND)
    _audit_return_check_action(
        db, claims=claims, action="update_return_check",
        target_id=str(row.id),
        target_label=(row.customer_name or "")[:160],
        summary=(
            f"check #{row.check_number or '?'} amount=${float(row.amount or 0):,.2f}"
        ),
    )
    db.commit()
    return ReturnCheckResponse(return_check=_row(row))


@router.delete("/{rc_id}", response_model=OkResponse)
def delete_route(
    rc_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> OkResponse:
    """Delete a returned check entered by mistake. Admin-only by
    default (``return_checks.delete``); the audit row keeps what the
    check was."""
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "delete")
    try:
        row = delete_return_check(db, store_id=sid, rc_id=rc_id)
    except ReturnCheckNotFoundError:
        raise HTTPException(status_code=404, detail="Return check not found")
    except ReturnCheckStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    _audit_return_check_action(
        db, claims=claims, action="delete_return_check",
        target_id=str(rc_id),
        target_label=(row.customer_name or "")[:160],
        summary=(
            f"check #{row.check_number or '?'} company={row.company_name or ''} "
            f"amount=${float(row.amount or 0):,.2f} fee=${float(row.return_check_fee or 0):,.2f} "
            f"bounced_on={row.bounced_on.isoformat() if row.bounced_on else ''} "
            f"status={row.status or ''} batch={row.batch_id or ''}"
        ),
    )
    db.commit()
    return OkResponse(ok=True)


def _transition(
    db: Session, store_id: int, rc_id: int, transition_fn,
    *, claims: dict[str, Any], action: str,
) -> ReturnCheckResponse:
    """Apply a `pending → loss / fraud / recovered → pending` Service
    transition and emit a matching audit row.  ``action`` is the
    audit-log verb (`mark_loss` / `mark_fraud` / `reopen`); it's
    distinct from the transition_fn so the audit feed can show
    the operator's intent rather than the new state."""
    try:
        row = transition_fn(db, store_id, rc_id)
    except ReturnCheckNotFoundError:
        raise HTTPException(status_code=404, detail="Return check not found")
    except ReturnCheckStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    _audit_return_check_action(
        db, claims=claims, action=action,
        target_id=str(row.id),
        target_label=(row.customer_name or "")[:160],
        summary=f"status=>{row.status or ''}",
    )
    db.commit()
    return ReturnCheckResponse(return_check=_row(row))


@router.post(
    "/{rc_id}/mark-loss",
    response_model=ReturnCheckResponse,
)
def mark_loss_route(
    rc_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "update")
    return _transition(
        db, sid, rc_id, mark_loss, claims=claims, action="mark_loss",
    )


@router.post(
    "/{rc_id}/mark-fraud",
    response_model=ReturnCheckResponse,
)
def mark_fraud_route(
    rc_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "update")
    return _transition(
        db, sid, rc_id, mark_fraud, claims=claims, action="mark_fraud",
    )


@router.post(
    "/{rc_id}/reopen",
    response_model=ReturnCheckResponse,
)
def reopen_route(
    rc_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "update")
    return _transition(
        db, sid, rc_id, reopen, claims=claims, action="reopen_return_check",
    )


def _payment_row(p) -> ReturnCheckPaymentRow:
    return ReturnCheckPaymentRow(
        id=p.id,
        return_check_id=p.return_check_id,
        amount=float(p.amount or 0),
        paid_on=p.paid_on.isoformat() if p.paid_on else "",
        method=p.payment_method or "",
        notes=p.note or "",
    )


@router.get(
    "/{rc_id}/payments",
    response_model=ReturnCheckPaymentsResponse,
)
def payments_route(
    rc_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckPaymentsResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "read")
    rc = find_return_check(db, int(sid), rc_id)
    if rc is None:
        raise HTTPException(status_code=404, detail="Return check not found")
    rows = list_payments(db, int(sid), rc_id)
    return ReturnCheckPaymentsResponse(
        payments=[_payment_row(p) for p in rows],
    )


@router.post(
    "/{rc_id}/payments",
    response_model=ReturnCheckPaymentResponse,
    status_code=201,
)
def record_payment_route(
    rc_id: int = Path(..., ge=1),
    body: ReturnCheckPaymentWriteRequest = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckPaymentResponse:
    """Record one installment payment against a pending or
    recovered return check. Auto-creates the matching
    ``DailyLineItem(kind='return_payback')`` and re-derives the
    daily-book total + parent status."""
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "update")
    paid_on = parse_iso_day(body.paid_on, field="paid_on")
    payload = RecordPaymentInput(
        paid_on=paid_on,
        amount=float(body.amount or 0),
        method=body.method,
        note=body.note,
    )
    try:
        payment = record_payment(
            db, store_id=sid, rc_id=rc_id,
            created_by=claims.get("sub"),
            payload=payload,
        )
    except ReturnCheckNotFoundError:
        raise HTTPException(status_code=404, detail="Return check not found")
    except ReturnCheckStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    # Payments are the single most-audited event on this surface —
    # each payment shifts money + can auto-flip the parent to
    # 'recovered'.  Summary carries the amount + paid_on date so a
    # reconciliation question ("did we credit this customer twice?")
    # is one feed lookup away.
    rc = find_return_check(db, sid, rc_id)
    _audit_return_check_action(
        db, claims=claims, action="record_payment",
        target_id=str(payment.id),
        target_label=(getattr(rc, "customer_name", "") or "")[:160],
        summary=(
            f"rc={rc_id} amount=${float(payment.amount or 0):,.2f} "
            f"paid_on={payment.paid_on.isoformat() if payment.paid_on else ''}"
        ),
    )
    db.commit()
    db.refresh(payment)
    return ReturnCheckPaymentResponse(
        payment=_payment_row(payment),
        return_check=_row(rc),
    )


@router.delete(
    "/{rc_id}/payments/{payment_id}",
    response_model=ReturnCheckPaymentResponse,
)
def delete_payment_route(
    rc_id: int = Path(..., ge=1),
    payment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> ReturnCheckPaymentResponse:
    sid = resolve_store_scope(claims)
    require_permission(claims, "return_checks", "delete")
    # Snapshot the payment before the Service deletes it so the audit
    # row carries the amount that walked out the door — answers
    # "we deleted payment #PID — how much was that?".
    from api.Modules.ReturnChecks.Repositories import find_payment
    pre_delete = find_payment(db, sid, rc_id, payment_id)
    pre_amount = float(getattr(pre_delete, "amount", 0) or 0)
    pre_paid_on = getattr(pre_delete, "paid_on", None) if pre_delete else None
    try:
        delete_payment(
            db, store_id=sid, rc_id=rc_id, payment_id=payment_id,
        )
    except ReturnCheckNotFoundError:
        raise HTTPException(status_code=404, detail="Return check not found")
    except ReturnCheckPaymentNotFoundError:
        raise HTTPException(status_code=404, detail="Payment not found")
    except ReturnCheckStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    rc = find_return_check(db, sid, rc_id)
    _audit_return_check_action(
        db, claims=claims, action="delete_payment",
        target_id=str(payment_id),
        target_label=(getattr(rc, "customer_name", "") or "")[:160],
        summary=(
            f"rc={rc_id} amount=${pre_amount:,.2f} "
            f"paid_on={pre_paid_on.isoformat() if pre_paid_on else ''}"
        ),
    )
    db.commit()
    return ReturnCheckPaymentResponse(
        payment=None,
        return_check=_row(rc),
    )
