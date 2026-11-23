"""StoreBook — Controllers.

  GET   /storebook/month?year=&month=   calendar month
  GET   /storebook/{day}                one day's sheet + layout
  PATCH /storebook/{day}                partial operator edit
  POST  /storebook/{day}/lock           lock / unlock
  POST  /storebook/{day}/restore        take back an imported value
  POST  /storebook/{day}/register       take the register's day close

Gated on the ``day_close`` resource — the Store Daily Book is the
same operator responsibility the Day close page carried, so the
permission an operator already has keeps working rather than
needing a new grant handed out before anyone can close a day.
"""
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from api.Core.Audit import audit_operator
from api.Core.Clock import parse_iso_day
from api.Core.Database import get_db
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services.principal import (
    require_permission, resolve_store_scope,
)
from api.Modules.StoreBook.Models import FIELD_GROUPS, StoreDailyEntry
from api.Modules.PosImport.Services.transactions import (
    register_stamp, store_timezone,
)
from api.Modules.StoreBook.Requests import (
    StoreBookDayResponse, StoreBookLockRequest, StoreBookMonthResponse,
    StoreBookMonthRow, StoreBookRegisterDay, StoreBookRegisterItem,
    StoreBookRestoreRequest, StoreBookTotals, StoreBookUpdateRequest,
)
from api.Modules.StoreBook.Services import (
    COUNT_FIELDS, DayLockedError, StoreBookError, column_totals,
    get_or_create_entry, month_summary, originals_for, over_short_cents,
    restore_original, set_lock, update_entry,
)
from api.Modules.StoreBook.Services.register_day import (
    RegisterDayNotReady, RegisterItem, is_pending, pull_register_day,
    register_day, register_day_enabled,
)

router = APIRouter(prefix="/storebook", tags=["storebook"])


def _register_items(items: list[RegisterItem]) -> list[StoreBookRegisterItem]:
    return [
        StoreBookRegisterItem(
            kind=i.kind, code=i.code, name=i.name,
            amount_cents=i.amount_cents,
        )
        for i in items
    ]


def _register_payload(
    db: Session, entry: StoreDailyEntry,
) -> StoreBookRegisterDay | None:
    """The register's day close beside the sheet, or None for a store
    without the register feed. Reads only."""
    store_id = int(entry.store_id)
    if not register_day_enabled(db, store_id):
        return None
    figures = register_day(db, store_id, entry.entry_date)
    zone = store_timezone(db, store_id)
    return StoreBookRegisterDay(
        has_data=figures.has_data,
        ready=figures.ready,
        pending=is_pending(entry, figures),
        problem=figures.problem,
        period_start=register_stamp(figures.period_start, zone),
        period_end=register_stamp(figures.period_end, zone),
        received_at=(
            figures.received_at.isoformat() if figures.received_at else None
        ),
        unmapped=_register_items(figures.unmapped),
        unplaced=_register_items(figures.unplaced),
    )


def _day_payload(db: Session, entry: StoreDailyEntry) -> StoreBookDayResponse:
    totals = column_totals(entry)
    return StoreBookDayResponse(
        entry_date=entry.entry_date.isoformat(),
        store_id=int(entry.store_id),
        values={
            key: int(getattr(entry, f"{key}_cents", 0) or 0)
            for column in FIELD_GROUPS
            for section in column["sections"]
            for field in section["fields"]
            for key in (field["key"],)
        },
        counts={
            key: float(getattr(entry, key, 0) or 0)
            for key in COUNT_FIELDS
        },
        originals=originals_for(entry),
        totals=StoreBookTotals(
            sales_cents=totals["sales"],
            tenders_cents=totals["tenders"],
            deposit_cents=totals["deposit"],
            over_short_cents=over_short_cents(entry),
        ),
        notes=entry.notes or "",
        is_locked=entry.locked_at is not None,
        locked_at=(
            entry.locked_at.isoformat() if entry.locked_at else None
        ),
        updated_at=(
            entry.updated_at.isoformat() if entry.updated_at else None
        ),
        layout=FIELD_GROUPS,  # type: ignore[arg-type]
        register_day=_register_payload(db, entry),
    )


@router.get("/month", response_model=StoreBookMonthResponse)
def storebook_month_route(
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> StoreBookMonthResponse:
    """Calendar month: the days that have a sheet, with each day's
    totals and lock state, plus month rollups for the header."""
    require_permission(claims, "day_close", "read")
    store_id = resolve_store_scope(claims)
    rows = month_summary(db, store_id, year, month)

    # Fuel rollups for the header cards come from the entries
    # themselves rather than a second query shape.
    from calendar import monthrange
    entries = (
        db.query(StoreDailyEntry)
        .filter(
            StoreDailyEntry.store_id == store_id,
            StoreDailyEntry.entry_date >= date(year, month, 1),
            StoreDailyEntry.entry_date
            <= date(year, month, monthrange(year, month)[1]),
        )
        .all()
    )
    return StoreBookMonthResponse(
        year=year, month=month,
        rows=[StoreBookMonthRow(**r) for r in rows],
        total_sales_cents=sum(r["sales_cents"] for r in rows),
        total_fuel_gallons=round(
            sum(float(e.fuel_gallons or 0) for e in entries), 3,
        ),
        total_fuel_cents=sum(
            int(e.fuel_amount_cents or 0) for e in entries
        ),
    )


@router.get("/{day}", response_model=StoreBookDayResponse)
def storebook_day_route(
    day: str = Path(...),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> StoreBookDayResponse:
    """One day's sheet. Creates the row on first open — the
    operator shouldn't have to 'start' a day before entering it."""
    require_permission(claims, "day_close", "read")
    store_id = resolve_store_scope(claims)
    entry = get_or_create_entry(db, store_id, parse_iso_day(day, field="day"))
    db.commit()
    return _day_payload(db, entry)


@router.patch("/{day}", response_model=StoreBookDayResponse)
def storebook_update_route(
    day: str = Path(...),
    body: StoreBookUpdateRequest = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> StoreBookDayResponse:
    """Partial edit. A locked day is refused with 409 so the SPA
    can tell 'you need to unlock' apart from a validation error."""
    require_permission(claims, "day_close", "update")
    store_id = resolve_store_scope(claims)
    entry = get_or_create_entry(db, store_id, parse_iso_day(day, field="day"))

    values: dict[str, Any] = {}
    values.update(body.values or {})
    values.update(body.counts or {})
    if body.notes is not None:
        values["notes"] = body.notes
    try:
        update_entry(db, entry, values)
    except DayLockedError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except StoreBookError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    audit_operator(
        db, claims, target_type="store_daily_entry", action="update",
        target_id=entry.entry_date.isoformat(),
        summary=f"updated the daily book for {entry.entry_date}",
    )
    db.commit()
    return _day_payload(db, entry)


@router.post("/{day}/lock", response_model=StoreBookDayResponse)
def storebook_lock_route(
    day: str = Path(...),
    body: StoreBookLockRequest = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> StoreBookDayResponse:
    """Lock or unlock the day. Needs Edit on the store daily book
    AND the ``day_lock`` switch (same switch as the MSB daily
    book's lock)."""
    require_permission(claims, "day_close", "update")
    require_permission(claims, "day_lock", "update")
    store_id = resolve_store_scope(claims)
    entry = get_or_create_entry(db, store_id, parse_iso_day(day, field="day"))
    set_lock(db, entry, locked=body.locked, user_id=int(claims["sub"]))
    audit_operator(
        db, claims, target_type="store_daily_entry",
        action="lock" if body.locked else "unlock",
        target_id=entry.entry_date.isoformat(),
        summary=(
            f"{'locked' if body.locked else 'unlocked'} the daily book "
            f"for {entry.entry_date}"
        ),
    )
    db.commit()
    return _day_payload(db, entry)


@router.post("/{day}/restore", response_model=StoreBookDayResponse)
def storebook_restore_route(
    day: str = Path(...),
    body: StoreBookRestoreRequest = ...,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> StoreBookDayResponse:
    """Take the register's number back for one overridden field."""
    require_permission(claims, "day_close", "update")
    store_id = resolve_store_scope(claims)
    entry = get_or_create_entry(db, store_id, parse_iso_day(day, field="day"))
    try:
        restore_original(db, entry, body.field_key)
    except DayLockedError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except StoreBookError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    audit_operator(
        db, claims, target_type="store_daily_entry", action="update",
        target_id=entry.entry_date.isoformat(),
        summary=(
            f"restored the imported value for {body.field_key} "
            f"on {entry.entry_date}"
        ),
    )
    db.commit()
    return _day_payload(db, entry)


@router.post("/{day}/register", response_model=StoreBookDayResponse)
def storebook_register_route(
    day: str = Path(...),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> StoreBookDayResponse:
    """Take the register's day close onto the sheet: empty boxes are
    filled, a box somebody typed in keeps its number and shows the
    register's beside it. The page calls this when it opens a day
    whose register figures it has not taken (``register_day.pending``),
    and from its Refresh button. A person asked, so a locked day is
    refused like any other edit."""
    require_permission(claims, "day_close", "update")
    store_id = resolve_store_scope(claims)
    if not register_day_enabled(db, store_id):
        raise HTTPException(
            status_code=404,
            detail="The register feed is not switched on for this store.",
        )
    entry = get_or_create_entry(db, store_id, parse_iso_day(day, field="day"))
    try:
        pull_register_day(db, entry)
    except (DayLockedError, RegisterDayNotReady) as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    audit_operator(
        db, claims, target_type="store_daily_entry", action="update",
        target_id=entry.entry_date.isoformat(),
        summary=(
            f"took the register's day close onto the daily book "
            f"for {entry.entry_date}"
        ),
    )
    db.commit()
    return _day_payload(db, entry)


__all__ = ["router"]
