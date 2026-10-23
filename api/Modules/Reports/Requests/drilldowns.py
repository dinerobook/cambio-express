"""Answers of the report drilldowns whose services build plain dicts.

Each route still returns ``{"rows": rows, "totals": totals}`` exactly
as its service built it; these models document that shape with
``response_model=None, responses={200: {"model": X}}`` and the test
suite's response contract proves it on every test answer. See
api/CLAUDE.md → "Every JSON answer documents its shape".
"""
from pydantic import BaseModel, ConfigDict


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Customers / transfers ────────────────────────────────────────


class NewVsReturningRow(_Strict):
    bucket: str
    customers: int
    txns: int
    sent: float
    tone: str


class NewVsReturningTotals(_Strict):
    customers: int
    txns: int
    sent: float
    new_count: int
    returning_count: int


class NewVsReturningResponse(_Strict):
    rows: list[NewVsReturningRow]
    totals: NewVsReturningTotals


class FeesVsTaxRow(_Strict):
    label: str
    amount: float
    note: str


class FeesVsTaxTotals(_Strict):
    fees: float
    tax: float
    count: int
    ratio: float


class FeesVsTaxResponse(_Strict):
    rows: list[FeesVsTaxRow]
    totals: FeesVsTaxTotals


class HighValueTransferRow(_Strict):
    send_date: str
    sender_name: str
    recipient_name: str
    country: str
    company: str
    amount: float
    fee: float
    tax: float
    confirm: str


class HighValueTransfersTotals(_Strict):
    count: int
    amount: float
    fees: float
    tax: float


class HighValueTransfersResponse(_Strict):
    rows: list[HighValueTransferRow]
    totals: HighValueTransfersTotals
    threshold: float


class CancelledTransferRow(_Strict):
    send_date: str
    sender_name: str
    recipient_name: str
    country: str
    company: str
    amount: float
    status: str
    status_notes: str
    confirm: str


class CancelledTransfersTotals(_Strict):
    count: int
    amount: float
    canceled: int
    rejected: int


class CancelledTransfersResponse(_Strict):
    rows: list[CancelledTransferRow]
    totals: CancelledTransfersTotals


class EmployeeActivityRow(_Strict):
    employee: str
    username: str
    count: int
    sent: float
    cancels: int
    last_activity: str | None


class EmployeeActivityTotals(_Strict):
    count: int
    sent: float
    cancels: int


class EmployeeActivityResponse(_Strict):
    rows: list[EmployeeActivityRow]
    totals: EmployeeActivityTotals


# ── Batches, checks, daily book ──────────────────────────────────


class AchVolumeRow(_Strict):
    company: str
    count: int
    amount: float
    avg: float


class CountAmountTotals(_Strict):
    count: int
    amount: float


class AchVolumeResponse(_Strict):
    rows: list[AchVolumeRow]
    totals: CountAmountTotals


class ReturnedCheckStatusRow(_Strict):
    status: str
    status_key: str
    count: int
    amount: float
    recovered: float


class ReturnedCheckStatusTotals(_Strict):
    count: int
    amount: float
    recovered: float
    fees: float
    loss_fraud: float
    net_gl: float


class ReturnedCheckStatusResponse(_Strict):
    rows: list[ReturnedCheckStatusRow]
    totals: ReturnedCheckStatusTotals


class DailyLineItemDayRow(_Strict):
    date: str
    count: int
    amount: float


class DailyLineItemTotals(_Strict):
    count: int
    amount: float
    avg_per_day: float


class DailyLineItemReportResponse(_Strict):
    """Daily drops and check deposits: one row per day."""

    rows: list[DailyLineItemDayRow]
    totals: DailyLineItemTotals


# ── Bank ─────────────────────────────────────────────────────────


class BankTxnBreakdownRow(_Strict):
    slug: str
    label: str
    count: int
    signed: float
    amount: float


class BankTxnBreakdownTotals(_Strict):
    count: int
    amount: float
    inflow: float
    outflow: float


class BankTxnBreakdownResponse(_Strict):
    rows: list[BankTxnBreakdownRow]
    totals: BankTxnBreakdownTotals


class BankRuleAuditRow(_Strict):
    rule_id: int
    label: str
    target: str
    match: str
    count: int
    amount: float


class BankRuleAuditTotals(_Strict):
    count: int
    amount: float
    rules: int


class BankRuleAuditResponse(_Strict):
    rows: list[BankRuleAuditRow]
    totals: BankRuleAuditTotals


class BankChargesRow(_Strict):
    account: str | None
    last4: str | None
    count: int
    amount: float
    avg: float


class BankChargesResponse(_Strict):
    rows: list[BankChargesRow]
    totals: CountAmountTotals


# ── P&L ──────────────────────────────────────────────────────────


class PeriodComparisonRow(_Strict):
    label: str
    current: float
    prior: float
    delta: float
    pct: float
    is_money: bool


class PeriodComparisonTotals(_Strict):
    current_label: str
    prior_label: str


class PeriodComparisonResponse(_Strict):
    rows: list[PeriodComparisonRow]
    totals: PeriodComparisonTotals


class PeriodPlRow(_Strict):
    label: str
    section: str
    amount: float


class PeriodPlTotals(_Strict):
    income: float
    expenses: float
    net: float
    days: int


class PeriodPlResponse(_Strict):
    rows: list[PeriodPlRow]
    totals: PeriodPlTotals
