"""Check cashing — the activated computer (FastAPI router).

Mounts at ``/api/v2/check-cashing/*`` WITHOUT the computer gate the
other check cashing routes carry, because this is how a computer
gets activated:

  GET  /device              is this the store's check cashing computer?
  POST /device/activate     make this computer the one (manage switch)
  POST /device/switch-off   switch the activated computer off (manage)

Same module flag and rights as the rest. Each change writes an
operator-audit row. Rules: ``INVARIANTS.md`` ("One computer").
"""
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from api.Core.Audit import audit_operator
from api.Core.Clock import iso
from api.Core.Database import get_db
from api.Modules.Auth.Controllers import _is_https_prod, get_principal
from api.Modules.Auth.Services.principal import require_permission
from api.Modules.CheckCashing.Controllers import MANAGE, _conflict, _scope
from api.Modules.CheckCashing.Models import CheckDevice
from api.Modules.CheckCashing.Requests import CheckDeviceBody, CheckDeviceResponse
from api.Modules.CheckCashing.Services import CheckCashingConflictError
from api.Modules.CheckCashing.Services.device import (
    COOKIE_MAX_AGE, COOKIE_PATH, activate, cookie_name, device_state,
    switch_off,
)
from api.Modules.Tenancy.Models import User

router = APIRouter(prefix="/check-cashing", tags=["check-cashing"])


def _response(db: Session, state: str, device: CheckDevice | None) -> CheckDeviceResponse:
    by = ""
    if device is not None and device.created_by:
        user = db.get(User, device.created_by)
        by = (user.full_name or user.username or "") if user else ""
    return CheckDeviceResponse(
        state=state,  # type: ignore[arg-type]
        name=device.name if device else "",
        activated_at=iso(device.created_at) if device else "",
        activated_by=by,
        last_seen_at=iso(device.last_seen_at) if device else "",
    )


@router.get("/device", response_model=CheckDeviceResponse)
def device_route(
    request: Request,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckDeviceResponse:
    sid = _scope(db, claims, "read")
    found = device_state(db, sid, request.cookies.get(cookie_name(sid)))
    return _response(db, found.state, found.device)


@router.post("/device/activate", response_model=CheckDeviceResponse)
def activate_route(
    body: CheckDeviceBody,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckDeviceResponse:
    sid = _scope(db, claims, "read")
    require_permission(claims, MANAGE, "update")
    try:
        row, token, old = activate(
            db, sid, name=body.name, user_id=int(claims["sub"]),
            user_agent=request.headers.get("user-agent", ""),
        )
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    summary = f"check cashing computer: {row.name}"
    if old is not None:
        summary += f" (replaces {old.name})"
    audit_operator(
        db, claims, action="activate_check_device",
        target_type="check_device", target_id=str(row.id),
        target_label=row.name, summary=summary,
    )
    db.commit()
    response.set_cookie(
        key=cookie_name(sid), value=token, max_age=COOKIE_MAX_AGE,
        httponly=True, samesite="strict", secure=_is_https_prod(),
        path=COOKIE_PATH,
    )
    return _response(db, "this", row)


@router.post("/device/switch-off", response_model=CheckDeviceResponse)
def switch_off_route(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckDeviceResponse:
    sid = _scope(db, claims, "read")
    require_permission(claims, MANAGE, "update")
    try:
        row = switch_off(db, sid, user_id=int(claims["sub"]))
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    audit_operator(
        db, claims, action="switch_off_check_device",
        target_type="check_device", target_id=str(row.id),
        target_label=row.name, summary=f"check cashing computer switched off: {row.name}",
    )
    db.commit()
    if request.cookies.get(cookie_name(sid)):
        response.delete_cookie(cookie_name(sid), path=COOKIE_PATH)
    return _response(db, "none", None)
