"""Answers of the store-admin routes that build a plain dict.

Documented with ``response_model=None, responses={200: {"model": X}}``:
the dict leaves exactly as built, and the test suite's response
contract (``tests/_response_contract.py``) proves it matches. See
api/CLAUDE.md → "Every JSON answer documents its shape".
"""
from pydantic import BaseModel, ConfigDict

from api.Core.Permissions.matrix_update import RoleGrid, UserPermissionMatrix


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Subscription page ────────────────────────────────────────────


class SubscriptionStore(_Strict):
    id: int
    name: str | None
    email: str | None
    plan: str | None
    stripe_customer_id: str | None
    stripe_subscription_id: str | None
    data_retention_until: str | None


class SubscriptionAddon(_Strict):
    key: str
    name: str
    price_label: str
    tagline: str
    description: str
    status: str
    is_active: bool


class SubscriptionSummaryResponse(_Strict):
    store: SubscriptionStore
    plan_label: str
    plan_price: str
    has_paid_plan: bool
    trial_status: str | None
    trial_days_left: int | None
    retention_days_left: int | None
    retention_total_days: int
    addons: list[SubscriptionAddon]
    active_addon_count: int
    cancel_at_period_end: bool
    cancel_at: str | None
    referral_code: str | None


# ── Custom access and saved roles ────────────────────────────────


class UserRoleAssignmentResponse(UserPermissionMatrix):
    """The person's grid after joining or leaving a saved role."""

    store_role_id: int | None
    store_role_name: str | None


class AccessRoleRow(_Strict):
    id: int
    name: str
    member_count: int
    matrix: RoleGrid
    updated_at: str | None


class AccessRoleListResponse(_Strict):
    resources: list[str]
    actions: list[str]
    roles: list[AccessRoleRow]


class AccessRoleMember(_Strict):
    id: int
    name: str
    role: str


class AccessRoleMembersResponse(_Strict):
    role_id: int
    name: str
    members: list[AccessRoleMember]


class AffectedMember(_Strict):
    id: int
    name: str


class AccessRoleUpdateResponse(AccessRoleRow):
    """The role after the edit, and whose access was rewritten."""

    affected_members: list[AffectedMember]


class AccessRoleDeleteResponse(_Strict):
    deleted: str
    detached: list[AffectedMember]


class RedeemConnectCodeResponse(_Strict):
    owner_name: str
