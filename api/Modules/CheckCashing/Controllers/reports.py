"""Check cashing — the period report (FastAPI router).

  GET /check-cashing/report?from=&to=&store_id=   totals, stores, days,
                                                   top parties, bad checks

View only, and the one check cashing route besides the device routes
that does NOT need the activated computer: owners and Admins read it
from the back office on any device, a phone included (owner,
2026-11-11). It changes nothing and shows no ID numbers or pictures.
Same module switch and ``check_cashing.read`` right as every check
cashing route; the Accountant is refused. An owner signed in without a
store sees every store of theirs that has check cashing on.
Rules: ``INVARIANTS.md`` ("Checks and reports").
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.Core.Clock import resolve_period, store_local_today
from api.Core.Database import get_db
from api.Core.StoreScope import authorize_store_ids
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services.principal import require_permission
from api.Modules.CheckCashing.Controllers import RESOURCE, _scope, _store_names
from api.Modules.CheckCashing.Requests import (
    CheckReportBadChecks,
    CheckReportDayRow,
    CheckReportPartyRow,
    CheckReportResponse,
    CheckReportStoreOption,
    CheckReportStoreRow,
    CheckTotalsOut,
)
from api.Modules.CheckCashing.Services import module_enabled, umbrella
from api.Modules.CheckCashing.Services.reports import Party, Totals, summary

router = APIRouter(prefix="/check-cashing", tags=["check-cashing"])

OFF = "Check cashing is not turned on for this store."


def _dollars(cents: int) -> float:
    return cents / 100.0


def _totals(t: Totals) -> dict[str, Any]:
    return {
        "cashed": t.cashed, "amount": _dollars(t.amount_cents),
        "fees": _dollars(t.fee_cents), "cash": _dollars(t.cash_cents),
        "average": round(_dollars(t.amount_cents) / t.cashed, 2) if t.cashed else 0.0,
        "declined": t.declined, "voided": t.voided,
    }


def _party(p: Party) -> CheckReportPartyRow:
    return CheckReportPartyRow(
        id=p.id, name=p.name, cashed=p.cashed, amount=_dollars(p.amount_cents),
    )


def _report_stores(db: Session, claims: dict[str, Any]) -> tuple[list[int], int]:
    """The stores the caller may report on (check cashing on in each),
    and the store whose calendar decides "today"."""
    if claims.get("role") == "owner" and claims.get("store_id") is None:
        require_permission(claims, RESOURCE, "read")
        stores = [
            s for s in sorted(authorize_store_ids(db, claims, []))
            if module_enabled(db, s)
        ]
        if not stores:
            raise HTTPException(status_code=403, detail=OFF)
        return stores, stores[0]
    sid = _scope(db, claims, "read")
    return [s for s in umbrella(db, sid) if module_enabled(db, s)], sid


@router.get("/report", response_model=CheckReportResponse)
def check_report_route(
    from_: str = Query("", alias="from", description="First store day (YYYY-MM-DD)."),
    to: str = Query("", description="Last store day (YYYY-MM-DD)."),
    store_id: int | None = Query(None, ge=1, description="One store; empty = all."),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckReportResponse:
    stores, home = _report_stores(db, claims)
    if store_id is not None:
        if store_id not in stores:
            raise HTTPException(status_code=403, detail="That store is not yours.")
        picked = [store_id]
    else:
        picked = stores
    d_from, d_to = resolve_period(from_, to, today=store_local_today(db, home))
    result = summary(db, picked, d_from, d_to)
    names = _store_names(db, set(stores))
    assert result.bad is not None
    return CheckReportResponse(
        from_day=d_from, to_day=d_to,
        totals=CheckTotalsOut(**_totals(result.totals)),
        store_options=[CheckReportStoreOption(id=s, name=names.get(s, "")) for s in stores],
        stores=[
            CheckReportStoreRow(store_id=s, store_name=names.get(s, ""), **_totals(t))
            for s, t in sorted(result.stores.items(), key=lambda kv: names.get(kv[0], ""))
        ],
        days=[CheckReportDayRow(day=d, **_totals(t)) for d, t in result.days.items()],
        companies=[_party(p) for p in result.companies],
        customers=[_party(p) for p in result.customers],
        bad_checks=CheckReportBadChecks(
            open_count=result.bad.open_count,
            open_owed=_dollars(result.bad.open_owed_cents),
            returned=result.bad.returned,
            returned_owed=_dollars(result.bad.returned_cents),
            paid_back=_dollars(result.bad.paid_back_cents),
        ),
    )
