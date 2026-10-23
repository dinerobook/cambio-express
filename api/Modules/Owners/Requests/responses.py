"""Answers of the owner routes that build a plain dict.

Documented with ``response_model=None, responses={200: {"model": X}}``:
the dict leaves exactly as built, and the test suite's response
contract (``tests/_response_contract.py``) proves the shape on every
test answer. See api/CLAUDE.md → "Every JSON answer documents its
shape".
"""
from pydantic import BaseModel, ConfigDict


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Dashboard ────────────────────────────────────────────────────


class OwnerStoreCard(_Strict):
    id: int
    name: str | None
    slug: str | None
    count: int
    volume: float
    over_short: float


class OwnerStoreVolume(_Strict):
    id: int
    name: str | None
    count: int
    volume: float


class OwnerCompanyBreakdown(_Strict):
    company: str
    count: int
    volume: float
    fees: float


class OwnerReturnCheckPeriod(_Strict):
    recoveries: float
    fee_income: float
    losses: float
    fraud: float
    net_gl: float
    pending: float
    pending_count: int


class OwnerAgingBucket(_Strict):
    label: str
    amount: float
    count: int


class OwnerDashboardResponse(_Strict):
    period: str
    prev_label: str
    period_start: str
    period_end: str
    store_count: int
    stores: list[OwnerStoreCard]
    agg_transfers: int
    agg_volume: float
    agg_over_short: float
    agg_transfers_delta: int
    agg_volume_delta: float
    agg_over_short_delta: float
    series_labels: list[str]
    series_volume: list[float]
    series_count: list[int]
    company_breakdown: list[OwnerCompanyBreakdown]
    store_comparison: list[OwnerStoreVolume]
    rc_period: OwnerReturnCheckPeriod
    rc_aging: list[OwnerAgingBucket]
    rc_labels: list[str]
    rc_recoveries: list[float]
    rc_losses: list[float]


# ── One store ────────────────────────────────────────────────────


class OwnerStoreSummary(_Strict):
    id: int
    name: str | None
    slug: str | None
    plan: str | None


class OwnerCompanyRow(_Strict):
    company: str
    count: int
    volume: float
    fees: float
    tax: float


class OwnerRecentTransfer(_Strict):
    id: int
    send_date: str
    sender_name: str | None
    recipient_name: str | None
    company: str | None
    send_amount: float
    country: str | None
    status: str | None


class OwnerStoreDetailResponse(_Strict):
    store: OwnerStoreSummary
    period: str
    prev_label: str
    period_start: str
    period_end: str
    company_rows: list[OwnerCompanyRow]
    period_count: int
    period_volume: float
    period_fees: float
    period_tax: float
    period_over_short: float
    prev_count: int
    prev_volume: float
    daily_labels: list[str]
    over_short_data: list[float]
    receipts_data: list[float]
    recent_transfers: list[OwnerRecentTransfer]


# ── People and activity across the umbrella ──────────────────────


class OwnerUserRow(_Strict):
    id: int
    username: str
    full_name: str
    role: str
    is_active: bool
    store_id: int | None
    store_name: str


class OwnerUserListResponse(_Strict):
    rows: list[OwnerUserRow]
    total: int
    page: int
    total_pages: int


class OwnerActivityRow(_Strict):
    type: str
    store_id: int
    store_name: str
    user_name: str
    user_role: str
    action: str
    target_type: str
    target_label: str
    summary: str
    created_at: str


class OwnerActivityListResponse(_Strict):
    rows: list[OwnerActivityRow]
    total: int
    page: int
    total_pages: int
