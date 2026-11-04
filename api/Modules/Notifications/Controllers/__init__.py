"""Notifications — routes. Today: the top-bar bell.

``GET`` only reads (root invariant 17: no GET changes state); the
store is the session's own (invariant 19: no store id is taken from
the client). See ``Services/bell``.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from api.Core.Database import get_db
from api.Core.Responses import OkResponse
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Notifications.Requests import (
    BellDismissRequest, BellResponse,
)
from api.Modules.Notifications.Services import bell

router = APIRouter()


@router.get("/bell", response_model=BellResponse)
def bell_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BellResponse:
    """The signed-in person's bell items for the store they are in."""
    return BellResponse(**bell.build_bell(db, claims))


@router.post("/bell/dismiss", response_model=OkResponse)
def bell_dismiss_route(
    body: BellDismissRequest,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> OkResponse:
    """Hide one item for this person until the store's next day."""
    bell.dismiss(db, claims, body.key)
    return OkResponse(ok=True)


@router.post("/bell/undismiss", response_model=OkResponse)
def bell_undismiss_route(
    body: BellDismissRequest,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> OkResponse:
    """Undo today's dismissal of one item (the toast's Undo)."""
    bell.undismiss(db, claims, body.key)
    return OkResponse(ok=True)
