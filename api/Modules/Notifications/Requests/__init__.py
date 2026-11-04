"""Notifications — request / response schemas (the bell)."""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field

from api.Modules.Notifications.Services.bell.types import BellItem


class BellResponse(BaseModel):
    """``GET /notifications/bell``. ``enabled: false`` (no store, or
    the store's ``notification_bell`` flag off) means the SPA shows
    no bell at all."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool
    # The store's calendar day the answer was built for.
    store_day: date | None
    # False during a superadmin "Sign in as": the bell shows, the
    # Dismiss buttons do not.
    can_dismiss: bool
    items: list[BellItem]


class BellDismissRequest(BaseModel):
    """Dismiss (or undo the dismissal of) one item for today."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(..., min_length=1, max_length=120)


__all__ = ["BellDismissRequest", "BellItem", "BellResponse"]
