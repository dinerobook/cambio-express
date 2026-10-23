"""Answers of the superadmin routes that build a plain dict.

Those routes declare ``response_model=None, responses={200: {"model":
X}}``: the dict leaves exactly as the route built it (nothing filtered,
so a live page can't lose a field), while the OpenAPI spec and the
SPA's generated types get the shape. The test suite's response
contract (``tests/_response_contract.py``) checks every answer a test
receives against these models — no missing key, no undocumented one.
"""
from typing import Any

from pydantic import BaseModel, ConfigDict

from api.Modules.Admin.Requests.audit_log import AdminAuditRow


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SuperadminOkResponse(_Strict):
    ok: bool


# ── Dashboard ────────────────────────────────────────────────────


class SuperadminPlanCount(_Strict):
    label: str
    count: int


class SuperadminCompanyVolume(_Strict):
    company: str
    count: int
    total: float


class SuperadminTopReferrer(_Strict):
    store_name: str | None
    slug: str | None
    code: str
    redeemed: int
    reward_total_cents: int


class SuperadminActivityRow(_Strict):
    when: str
    kind: str
    store_name: str | None
    detail: str
    plan: str | None


class SuperadminMrrTrend(_Strict):
    labels: list[str]
    values: list[int]


class SuperadminDashboardResponse(_Strict):
    total_stores: int
    active_count: int
    trial_count: int
    paid_count: int
    inactive_count: int
    estimated_mrr: int
    new_stores_30d: int
    new_stores_delta: int
    churn_30d: int
    churn_delta: int
    basic_count: int
    pro_count: int
    basic_monthly: int
    basic_yearly: int
    pro_monthly: int
    pro_yearly: int
    basic_monthly_mrr: int
    basic_yearly_mrr: int
    pro_monthly_mrr: int
    pro_yearly_mrr: int
    signup_labels: list[str]
    signup_direct: list[int]
    signup_referral: list[int]
    plan_dist: list[SuperadminPlanCount]
    volume_by_company: list[SuperadminCompanyVolume]
    total_volume_30d: float
    total_transfers_30d: int
    top_referrers: list[SuperadminTopReferrer]
    direct_signups: int
    referral_signups: int
    activity: list[SuperadminActivityRow]
    mrr_trend: SuperadminMrrTrend


class SuperadminMaintenanceResponse(_Strict):
    enabled: bool
    message: str


# ── Users ────────────────────────────────────────────────────────


class SuperadminUserRow(_Strict):
    id: int
    username: str
    full_name: str
    email: str
    role: str
    store_id: int | None
    store_name: str
    is_active: bool
    has_2fa: bool
    last_login_at: str
    created_at: str


class SuperadminUserListResponse(_Strict):
    rows: list[SuperadminUserRow]
    total: int
    page: int
    total_pages: int


class SuperadminChangeRoleResponse(_Strict):
    ok: bool
    role: str


class SuperadminPlatformUser(_Strict):
    id: int
    username: str
    full_name: str
    email: str
    role: str


class SuperadminPlatformUserResponse(_Strict):
    ok: bool
    user: SuperadminPlatformUser


class SuperadminToggleActiveResponse(_Strict):
    ok: bool
    is_active: bool


class SuperadminTempPasswordResponse(_Strict):
    ok: bool
    temp_password: str


class SuperadminRevokeSessionsResponse(_Strict):
    ok: bool
    revoked_count: int


class SuperadminImpersonatedUser(_Strict):
    id: int
    username: str
    role: str | None
    store_id: int | None
    full_name: str


class SuperadminImpersonateResponse(_Strict):
    token: str
    user: SuperadminImpersonatedUser


# ── Billing overview, email log ──────────────────────────────────


class SuperadminBillingStoreRow(_Strict):
    store_id: int
    name: str
    slug: str
    plan: str
    email: str
    trial_ends_at: str | None = None
    grace_ends_at: str | None = None
    data_retention_until: str | None = None
    days_left: int | None = None
    canceled_at: str | None = None


class SuperadminBillingOverviewResponse(_Strict):
    expiring_soon: list[SuperadminBillingStoreRow]
    in_grace: list[SuperadminBillingStoreRow]
    retention_queue: list[SuperadminBillingStoreRow]
    recent_cancels: list[SuperadminBillingStoreRow]
    webhook_stats: dict[str, int]


class SuperadminEmailEventRow(_Strict):
    id: int
    to_addr: str
    event_type: str
    bounce_type: str
    message_id: str
    created_at: str


class SuperadminSuppressedAddress(_Strict):
    user_id: int
    username: str
    email: str | None
    bounced_at: str


class SuperadminEmailLogResponse(_Strict):
    rows: list[SuperadminEmailEventRow]
    total: int
    page: int
    total_pages: int
    suppressed: list[SuperadminSuppressedAddress]


# ── Store drill, store activity ──────────────────────────────────


class SuperadminDrillStore(_Strict):
    id: int
    name: str
    slug: str
    email: str
    phone: str
    address: str
    plan: str
    billing_cycle: str
    is_active: bool
    trial_status: str
    created_at: str
    trial_ends_at: str
    canceled_at: str
    stripe_customer_id: str
    frozen: bool
    frozen_at: str
    frozen_reason: str
    comped: bool
    comped_at: str
    comp_reason: str


class SuperadminDrillTeamMember(_Strict):
    id: int
    username: str
    full_name: str
    role: str
    email: str
    is_active: bool
    has_2fa: bool
    last_login_at: str


class SuperadminDrillRosterRow(_Strict):
    id: int
    name: str
    is_active: bool


class SuperadminDrillTransfer(_Strict):
    id: int
    send_date: str
    sender_name: str
    recipient_name: str
    company: str
    send_amount: float
    fee: float
    total_collected: float
    status: str
    created_at: str


class SuperadminDrillStats(_Strict):
    transfer_count: int
    volume: float
    fees: float


class SuperadminStoreDrillResponse(_Strict):
    store: SuperadminDrillStore
    team: list[SuperadminDrillTeamMember]
    roster: list[SuperadminDrillRosterRow]
    recent_transfers: list[SuperadminDrillTransfer]
    stats_30d: SuperadminDrillStats


class SuperadminStoreAuditLogResponse(_Strict):
    rows: list[AdminAuditRow]
    total: int
    page: int
    per_page: int
    total_pages: int


# ── System health ────────────────────────────────────────────────


class SuperadminDbHealth(_Strict):
    ok: bool
    error: str
    total_users: int
    total_stores: int
    total_transfers: int


class SuperadminStripeHealth(BaseModel):
    """``check_stripe_integration()``. Which keys appear depends on
    how far the probe got (no key, Stripe down, fully checked), so
    every field past ``ok`` is optional and extra keys pass."""

    model_config = ConfigDict(extra="allow")

    ok: bool
    error: str = ""
    env: dict[str, bool] | None = None
    price_ok: dict[str, bool] | None = None
    price_errors: dict[str, str] | None = None
    fc_ok: bool | None = None
    fc_error: str | None = None
    key_pair_match: bool | None = None
    account_id: str | None = None
    account_email: str | None = None
    mode: str | None = None


class SuperadminEmailHealth(_Strict):
    configured: bool
    error: str = ""
    status: str | None = None
    recent_events: dict[str, int] | None = None
    suppressed_count: int | None = None
    last_event_at: str | None = None


class SuperadminQueueHealth(_Strict):
    enabled: bool
    redis_configured: bool


class SuperadminRateLimitHealth(_Strict):
    enabled: bool


class SuperadminEnvInfo(_Strict):
    python_version: str
    platform: str
    server_time: str
    database_url_set: bool
    secret_key_set: bool
    sentry_dsn_set: bool
    webauthn_rp_id: str


class SuperadminSystemHealthResponse(_Strict):
    db: SuperadminDbHealth
    stripe: SuperadminStripeHealth
    email: SuperadminEmailHealth
    queue: SuperadminQueueHealth
    rate_limiting: SuperadminRateLimitHealth
    env: SuperadminEnvInfo


# ── Store actions ────────────────────────────────────────────────


class SuperadminRetentionStore(_Strict):
    store_id: int
    name: str
    slug: str
    canceled_at: str
    data_retention_until: str
    row_count: int
    row_counts: dict[str, int]


class SuperadminRetentionDryRunResponse(_Strict):
    now: str
    store_count: int
    total_child_rows: int
    stores: list[SuperadminRetentionStore]


class SuperadminClearRetentionResponse(_Strict):
    ok: bool
    already_clear: bool | None = None


class SuperadminBulkActionResult(_Strict):
    store_id: int
    name: str | None
    skipped: str | None = None
    trial_ends_at: str | None = None
    is_active: bool | None = None


class SuperadminBulkActionResponse(_Strict):
    ok: bool
    count: int
    results: list[SuperadminBulkActionResult]


class SuperadminStoreEmailResponse(_Strict):
    ok: bool
    sent_to: list[str]
    total: int


# ── BI report drilldown ──────────────────────────────────────────


class SuperadminReportDrilldownResponse(BaseModel):
    """``GET /superadmin/reports/{slug}`` — generic across ~20
    reports: the SPA builds its KPIs from ``totals`` and its columns
    from the first row's keys. Some reports add extra top-level keys
    (a series beside the totals), so extras pass."""

    model_config = ConfigDict(extra="allow")

    rows: list[dict[str, Any]]
    totals: dict[str, Any]
