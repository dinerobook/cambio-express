"""Check cashing — pictures (FastAPI router).

Mounts at ``/api/v2/check-cashing/*`` beside the other check cashing
routes, behind the same gate (``check_desk`` flag, a ``check_cashing``
right, the store's activated computer):

  POST /pictures         save a picture (base64): a check side, an ID
                         side or the customer's photo
  GET  /pictures/{id}    the picture itself (JPEG)

A check picture needs ``check_cashing.create`` (it joins the check
when the check is saved); an ID picture or the photo changes a profile
and needs ``check_cashing.update``; looking needs ``check_cashing.read``.
Rules: ``INVARIANTS.md`` ("Pictures").
"""
import base64
import binascii
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Response
from sqlalchemy.orm import Session

from api.Core.Audit import audit_operator
from api.Core.Database import get_db
from api.Modules.Auth.Controllers import get_principal
from api.Modules.CheckCashing.Controllers import (
    _conflict, _not_found, _scope, require_check_device,
)
from api.Modules.CheckCashing.Models import CHECK_PICTURE_KINDS
from api.Modules.CheckCashing.Requests import CheckPictureBody, CheckPictureResponse
from api.Modules.CheckCashing.Services import (
    CheckCashingConflictError,
    CheckCashingNotFoundError,
    mask,
    umbrella,
)
from api.Modules.CheckCashing.Services.pictures import (
    add_check_picture,
    add_customer_picture,
    get_picture,
)

router = APIRouter(
    prefix="/check-cashing", tags=["check-cashing"],
    dependencies=[Depends(require_check_device)],
)

KIND_WORDS = {
    "id_front": "front of ID", "id_back": "back of ID", "photo": "photo",
}


def _decode(content_base64: str) -> bytes:
    text = content_base64.split(",", 1)[1] if content_base64.startswith("data:") else content_base64
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="The picture is not valid base64.")


@router.post("/pictures", response_model=CheckPictureResponse, status_code=201)
def add_picture_route(
    body: CheckPictureBody,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> CheckPictureResponse:
    is_check = body.kind in CHECK_PICTURE_KINDS
    sid = _scope(db, claims, "create" if is_check else "update")
    raw = _decode(body.content_base64)
    try:
        if is_check:
            row = add_check_picture(
                db, sid, kind=body.kind, raw=raw, user_id=int(claims["sub"]),
            )
        else:
            assert body.customer_id is not None
            row, customer, id_row = add_customer_picture(
                db, sid, umbrella(db, sid), customer_id=body.customer_id,
                kind=body.kind, raw=raw, user_id=int(claims["sub"]),
                id_row_id=body.id_row_id,
            )
            what = KIND_WORDS[body.kind]
            if id_row is not None:
                what += f" {id_row.id_type} {mask(id_row.id_number)}"
            audit_operator(
                db, claims, action="add_check_customer_picture",
                target_type="check_customer", target_id=str(customer.id),
                target_label=customer.full_name, summary=what,
            )
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    except CheckCashingConflictError as exc:
        raise _conflict(exc)
    db.commit()
    return CheckPictureResponse(
        id=row.id, kind=row.kind, width=row.width, height=row.height,  # type: ignore[arg-type]
        size_bytes=row.size_bytes,
    )


@router.get("/pictures/{picture_id}", response_class=Response)
def get_picture_route(
    picture_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> Response:
    sid = _scope(db, claims, "read")
    try:
        row = get_picture(db, umbrella(db, sid), picture_id)
    except CheckCashingNotFoundError as exc:
        raise _not_found(exc)
    return Response(
        content=row.data, media_type=row.mime,
        headers={
            # IDs and faces: never left in a browser cache.
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
