"""Answers of the sign-in shell routes that build a plain dict.

Documented with ``response_model=None, responses={200: {"model": X}}``:
the dict leaves exactly as built (nothing filtered — these feed every
page load), and the test suite's response contract proves the shape.
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StatusOkResponse(_Strict):
    """Password change / forgot / reset: always ``{"status": "ok"}``
    (forgot-password never reveals whether an account exists)."""

    status: str


class MeResponse(_Strict):
    user_id: int
    username: str
    full_name: str
    role: str
    store_id: int | None
    permissions: list[str]


class ImpersonationInfo(_Strict):
    by_user_id: int
    by_name: str
    read_only: bool


class TrialBanner(_Strict):
    """``trial_banner()`` — the topbar trial countdown."""

    status: Literal["active", "expiring_soon", "grace", "expired"]
    days_left: int
    tone: Literal["neutral", "warning", "negative"]
    message: str


class SessionStatusResponse(_Strict):
    gated: bool
    reason: Literal["frozen", "subscription", ""]
    impersonation: ImpersonationInfo | None
    plan: str
    store_name: str
    timezone: str
    business_type: str
    features: list[str]
    permissions: list[str]
    trial: TrialBanner | None
