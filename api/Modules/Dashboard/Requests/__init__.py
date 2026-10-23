"""Answer of ``GET /dashboard/summary`` — one shape per role.

The route returns the dict its builders make, unchanged; this model
documents it (``response_model=None, responses={200: {"model": …}}``)
and the test suite's response contract proves it on every test
answer. ``role`` tells the three apart.
"""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Module blocks ────────────────────────────────────────────────


class TopDepartment(_Strict):
    name: str
    amount: float


class DayCloseSnapshot(_Strict):
    date: str
    gross_sales: float
    sales_tax: float
    over_short: float | None
    uncounted_drawers: int
    closes: int
    top_departments: list[TopDepartment]


class LotterySnapshot(_Strict):
    date: str
    tickets_sold: int
    value: float
    uncounted_active_packs: int
    active_packs: int


class RegisterActivityBlock(_Strict):
    date: str
    is_today: bool
    receipts: int
    voided_tickets: int
    refunds: int
    total_rung: float
    fuel_gallons: float
    fuel_sales: float


class HourlyBlock(_Strict):
    current_date: str
    previous_date: str | None
    current: list[float]
    previous: list[float] | None
    current_total: float
    previous_total: float | None


class SalesTrendPoint(_Strict):
    date: str
    amount: float


class SalesBlock(_Strict):
    today: float
    yesterday: float
    month_to_date: float
    d7: float
    d15: float
    d30: float
    trend: list[SalesTrendPoint]
    hourly: HourlyBlock | None


class PurchasesBlock(_Strict):
    today: float
    d7: float
    d15: float
    d30: float
    open_count: int
    open_total: float


class TransfersRollup(_Strict):
    today: float
    d7: float
    d15: float
    d30: float


class ClockedInRow(_Strict):
    name: str
    clock_in_at: str | None


class ReceiptRow(_Strict):
    id: int
    transaction_no: str
    register_id: str
    cashier_id: str
    receipt_at: str | None
    business_date: str
    total: float
    has_voided_line: bool


# ── Admin ────────────────────────────────────────────────────────


class AdminDashboardKpis(_Strict):
    total_transfers: int
    today_transfers: int
    pending_ach: int
    today_report_entered: bool
    net_income_month: float | None


class CompanyStat(_Strict):
    company: str
    count: int
    total: float
    fees: float


class DashboardTransferRow(_Strict):
    id: int
    send_date: str
    sender_name: str | None
    company: str | None
    send_amount: float
    status: str | None


class DashboardBatchRow(_Strict):
    id: int
    ach_date: str
    company: str | None
    ach_amount: float
    variance: float
    status: str | None


class DashboardBankAccount(_Strict):
    id: int
    display_name: str | None
    institution_name: str | None
    last4: str | None
    last_balance: float
    last_balance_as_of: str | None


class AdminDashboard(_Strict):
    role: Literal["admin"]
    today: str
    modules: list[str]
    day_close: DayCloseSnapshot | None
    lottery: LotterySnapshot | None
    sales: SalesBlock | None
    purchases: PurchasesBlock | None
    clocked_in: list[ClockedInRow]
    # ``register`` is a BaseModel method name, so the field takes it
    # as an alias.
    register_: RegisterActivityBlock | None = Field(alias="register")
    recent_receipts: list[ReceiptRow]
    transfers_rollup: TransfersRollup | None
    kpis: AdminDashboardKpis
    company_stats: list[CompanyStat]
    recent_transfers: list[DashboardTransferRow]
    recent_batches: list[DashboardBatchRow]
    stripe_accounts: list[DashboardBankAccount]


# ── Employee ─────────────────────────────────────────────────────


class EmployeeTodayRow(_Strict):
    id: int
    created_at: str | None
    sender_name: str | None
    company: str | None
    service_type: str
    payment_method: str
    send_amount: float
    fee: float
    recipient_name: str | None
    country: str | None
    confirm_number: str | None
    status: str | None


class EmployeeTotals(_Strict):
    sent: float
    paid_out: float
    fees: float
    count: int


class EmployeeDashboard(_Strict):
    role: Literal["employee"]
    today: str
    modules: list[str]
    day_close: DayCloseSnapshot | None
    lottery: LotterySnapshot | None
    # ``register`` is a BaseModel method name, so the field takes it
    # as an alias.
    register_: RegisterActivityBlock | None = Field(alias="register")
    today_transfers: list[EmployeeTodayRow]
    totals: EmployeeTotals


# ── Superadmin ───────────────────────────────────────────────────


class SuperadminDashboard(BaseModel):
    """The platform context (``superadmin_dashboard_context``) with
    the KPI aliases the SPA reads. Wide and loosely shaped: the SPA
    reads a handful of keys, so the rest pass undocumented."""

    model_config = ConfigDict(extra="allow")

    role: Literal["superadmin"]


DashboardSummaryResponse = Annotated[
    AdminDashboard | EmployeeDashboard | SuperadminDashboard,
    Field(discriminator="role"),
]
