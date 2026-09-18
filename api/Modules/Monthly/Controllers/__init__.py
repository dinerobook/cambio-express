"""Monthly module — Controllers (FastAPI router).

Mounts at `/api/v2/monthly/*`. Read-side endpoints:

  GET /monthly/months         → list of (year, month) the store has logged
  GET /monthly/labels         → the store's name for each P&L line
  PUT /monthly/labels         → rename P&L lines
  GET /monthly/{year}/{month} → single-month P&L breakdown or 404

JWT-required, scoped to the principal's store. Superadmin (no
store scope) → 403. Write-side stays on Flask.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy.orm import Session

from api.Core.Audit import audit_operator
from api.Core.Database import get_db
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services import resolve_store_scope
from api.Modules.Auth.Services.principal import require_permission
from api.Modules.Monthly.Repositories import list_logged_months
from api.Modules.Monthly.Requests import (
    MonthLogged,
    MonthlyLabelsResponse,
    MonthlyLabelsUpdateRequest,
    MonthlyLineLabelRow,
    MonthlyResponse,
    MonthlyRow,
    MonthlyUpdateRequest,
    MonthsLoggedResponse,
)
from api.Modules.Monthly.Services import (
    MONTHLY_LINE_DEFAULTS,
    MONTHLY_LINE_SECTIONS,
    NAMEABLE_SLOT_FIELDS,
    MonthlySummary,
    UnknownMonthlyLineError,
    custom_line_labels,
    resolved_line_labels,
    set_line_labels,
    summarize_monthly,
    update_monthly,
)
from typing import Any


router = APIRouter()


def _to_row(s: MonthlySummary) -> MonthlyRow:
    r = s.row
    # Build a kwarg dict for every Pydantic field by introspecting
    # MonthlyRow's annotations — keeps the adapter from drifting
    # if a column is added / removed.
    kw: dict[str, Any] = {
        "id": r.id, "store_id": r.store_id,
        "year": int(r.year), "month": int(r.month),
        "notes": r.notes or "",
        "total_income":   s.total_income,
        "total_expenses": s.total_expenses,
        "net_profit":     s.net_profit,
        "bank_locked":    sorted(s.bank_fed),
    }
    for f in MonthlyRow.model_fields:
        if f in kw:
            continue
        # Bank-fed columns read the live sum, not the stored value.
        kw[f] = s.value(f)
    return MonthlyRow(**kw)


@router.get("/months", response_model=MonthsLoggedResponse)
def months_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MonthsLoggedResponse:
    require_permission(claims, "monthly", "read")
    store_id = resolve_store_scope(claims)
    pairs = list_logged_months(db, store_id)
    return MonthsLoggedResponse(
        months=[MonthLogged(year=y, month=m) for y, m in pairs],
    )


@router.get(
    "/{year}/{month}",
    response_model=MonthlyResponse,
)
def monthly_route(
    year: int = Path(..., ge=2000, le=2100),
    month: int = Path(..., ge=1, le=12),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MonthlyResponse:
    require_permission(claims, "monthly", "read")
    store_id = resolve_store_scope(claims)
    summary = summarize_monthly(db, store_id, int(year), int(month))
    if summary is None:
        raise HTTPException(
            status_code=404,
            detail="No monthly P&L logged for this period",
        )
    return MonthlyResponse(
        report=_to_row(summary),
        labels=resolved_line_labels(db, store_id),
    )


@router.put(
    "/{year}/{month}",
    response_model=MonthlyResponse,
)
def update_monthly_route(
    year: int = Path(..., ge=2000, le=2100),
    month: int = Path(..., ge=1, le=12),
    body: MonthlyUpdateRequest = Body(...),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MonthlyResponse:
    """Save the editable monthly P&L fields. Server auto-derives
    daily-summed + return-check-net + bank-charge fields and
    overwrites client values for those — same locked-fields
    contract as the legacy /monthly/<year>/<month> POST.

    JWT-required. Principal's store_id MUST match the URL scope
    (cross-store / superadmin → 403). Admin role required (the
    legacy admin-side route is gated by admin_required).

    Auto-creates the row when missing.
    """
    require_permission(claims, "monthly", "update")
    sid = resolve_store_scope(claims)
    payload = body.model_dump(exclude_unset=True)
    notes = payload.pop("notes", "")
    fields = {k: v for k, v in payload.items() if v is not None}
    update_monthly(
        db,
        store_id=sid, year=int(year), month=int(month),
        fields=fields, notes=notes,
    )
    db.commit()
    summary = summarize_monthly(db, sid, int(year), int(month))
    if summary is None:
        raise HTTPException(
            status_code=500, detail="Monthly disappeared after save",
        )
    return MonthlyResponse(
        report=_to_row(summary),
        labels=resolved_line_labels(db, sid),
    )


# ── P&L line names ────────────────────────────────────────────
#
# The P&L ships with the names the first customers used — "Boost
# Mobile", "Money order rent", "EmagineNet / tech" — and a store in
# a different line of business recognises about half of them. These
# two endpoints let it use its own words. What they change is a
# label and nothing else: the column keeps its name, so every bank
# rule, every tagged transaction and every month already closed
# still point at the same place. See `Services/labels.py`.


def _labels_payload(db: Session, store_id: int) -> MonthlyLabelsResponse:
    from api.Modules.BankSync.Services import BANK_PL_CATEGORIES

    custom = custom_line_labels(db, store_id)
    taggable = set(BANK_PL_CATEGORIES.values())
    return MonthlyLabelsResponse(lines=[
        MonthlyLineLabelRow(
            field=field,
            label=custom.get(field) or default,
            default_label=default,
            is_custom=field in custom,
            section=MONTHLY_LINE_SECTIONS[field],
            is_slot=field in NAMEABLE_SLOT_FIELDS,
            bank_taggable=field in taggable,
        )
        for field, default in MONTHLY_LINE_DEFAULTS.items()
    ])


@router.get("/labels", response_model=MonthlyLabelsResponse)
def monthly_labels_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MonthlyLabelsResponse:
    """Every renameable P&L line with the store's name for it.

    Read-permission only: an employee who can see the P&L should
    see it under the same names the admin does.
    """
    require_permission(claims, "monthly", "read")
    return _labels_payload(db, resolve_store_scope(claims))


@router.put("/labels", response_model=MonthlyLabelsResponse)
def update_monthly_labels_route(
    body: MonthlyLabelsUpdateRequest = Body(...),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MonthlyLabelsResponse:
    """Rename P&L lines. Partial — only the lines in the body are
    touched, and an empty value resets one to its shipped default.

    Renaming is a per-store bookkeeping decision, so it takes
    `monthly.update` (the same right as editing the month) and
    writes an audit row naming the lines that moved.
    """
    require_permission(claims, "monthly", "update")
    sid = resolve_store_scope(claims)
    before = custom_line_labels(db, sid)
    try:
        set_line_labels(db, sid, body.labels)
    except UnknownMonthlyLineError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "field": exc.field,
                "message": f"'{exc.field}' is not a renameable P&L line.",
            },
        ) from exc
    after = custom_line_labels(db, sid)
    changed = sorted(
        f for f in set(before) | set(after)
        if before.get(f) != after.get(f)
    )
    if changed:
        audit_operator(
            db, claims,
            action="monthly_labels_update",
            target_type="monthly_line_label",
            target_id="",
            target_label=", ".join(
                f"{f} → {after.get(f) or MONTHLY_LINE_DEFAULTS[f]}"
                for f in changed
            )[:200],
            summary=f"Renamed {len(changed)} P&L line"
                    f"{'' if len(changed) == 1 else 's'}",
            store_id=sid,
        )
    db.commit()
    return _labels_payload(db, sid)
