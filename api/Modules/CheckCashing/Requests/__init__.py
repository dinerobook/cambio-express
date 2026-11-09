"""Check cashing — request / response schemas.

Money crosses the API as dollars (the app-wide contract); cents stay
in the database. A fee is ``fee_kind`` + ``fee_value``: for
``percent`` the value is a percent (1.5 = 1.5%), for ``flat`` it is
dollars (3.00). Both are stored as the value × 100 (basis points or
cents). Lists use the shared pagination envelope.
"""
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

FeeKind = Literal["percent", "flat"]
PartyStatus = Literal["normal", "trusted", "blocked"]
ExpiredIdMode = Literal["warn", "block"]
IdType = Literal[
    "drivers_license", "state_id", "passport", "matricula",
    "military_id", "other",
]

# A percent fee above 100% or a flat fee above $10,000 is a typo.
MAX_PERCENT = 100.0
MAX_FLAT = 10_000.0
# Base charge limits (dollars).
MAX_MONEY = 1_000_000.0


def _check_fee(kind: str | None, value: float | None, *, required: bool) -> None:
    if kind is None:
        if value is not None:
            raise ValueError("Pick percent or dollar amount for the fee.")
        if required:
            raise ValueError("A fee type is required.")
        return
    if value is None:
        raise ValueError("Enter the fee amount.")
    cap = MAX_PERCENT if kind == "percent" else MAX_FLAT
    if value > cap:
        raise ValueError(
            "The fee percent cannot be over 100." if kind == "percent"
            else "The fee cannot be over $10,000.",
        )


class _FeeFields(BaseModel):
    """Optional own fee — the customer's or the company's. NULL kind
    means "use the next rule" (company, then the store default)."""
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    fee_kind:  FeeKind | None = None
    fee_value: float | None = Field(None, ge=0)

    @model_validator(mode="after")
    def _fee_pair(self) -> "_FeeFields":
        _check_fee(self.fee_kind, self.fee_value, required=False)
        return self


# ── Settings ───────────────────────────────────────────────


class CheckSettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    default_fee_kind:  FeeKind
    default_fee_value: float = Field(..., ge=0)
    # Both set = checks under ``base_charge_under`` pay at least
    # ``base_charge``; both empty = no base charge.
    base_charge:       float | None = Field(None, gt=0, le=MAX_MONEY)
    base_charge_under: float | None = Field(None, gt=0, le=MAX_MONEY)
    expired_id_mode:   ExpiredIdMode = "warn"
    # Most one customer may cash in one store day across the owner's
    # stores before a manager must approve; empty = no limit.
    daily_limit:       float | None = Field(None, gt=0, le=MAX_MONEY)

    @model_validator(mode="after")
    def _rules(self) -> "CheckSettingsBody":
        _check_fee(self.default_fee_kind, self.default_fee_value, required=True)
        if (self.base_charge is None) != (self.base_charge_under is None):
            raise ValueError(
                "Enter both the base charge and the check amount it applies under, "
                "or leave both empty.",
            )
        return self


class CheckSettingsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    default_fee_kind:  FeeKind
    default_fee_value: float
    base_charge:       float | None
    base_charge_under: float | None
    expired_id_mode:   ExpiredIdMode
    daily_limit:       float | None


# ── Customers ──────────────────────────────────────────────


class CheckCustomerIdBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id_type:    IdType
    id_number:  str = Field(..., min_length=1, max_length=60)
    issuer:     str = Field("", max_length=60)
    expires_on: date | None = None


class CheckCustomerIdRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    id_type: str
    id_number: str
    issuer: str
    expires_on: date | None
    expired: bool


class _CheckCustomerFields(_FeeFields):
    full_name:     str = Field(..., min_length=1, max_length=120)
    dob:           date | None = None
    phone_country: str = Field("+1", max_length=8)
    phone_number:  str = Field("", max_length=40)
    address:       str = Field("", max_length=255)
    status:        PartyStatus = "normal"
    status_reason: str = Field("", max_length=255)
    notes:         str = Field("", max_length=4000)


class CheckCustomerCreateBody(_CheckCustomerFields):
    # No check is cashed without an ID on file (owner, 2026-11-07),
    # so a customer is born with at least one.
    ids: list[CheckCustomerIdBody] = Field(..., min_length=1, max_length=10)


class CheckCustomerUpdateBody(_CheckCustomerFields):
    """The whole profile except the IDs, which have their own routes."""


class CheckCustomerRow(BaseModel):
    """One line of the customer list."""
    model_config = ConfigDict(extra="forbid")

    id: int
    full_name: str
    phone_country: str
    phone_number: str
    status: str
    # The first ID, masked to its last 4 characters, for the list.
    id_summary: str
    has_expired_id: bool
    home_store_name: str
    created_at: str


class CheckCustomerDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    full_name: str
    dob: date | None
    phone_country: str
    phone_number: str
    address: str
    status: str
    status_reason: str
    fee_kind: str | None
    fee_value: float | None
    notes: str
    ids: list[CheckCustomerIdRow]
    home_store_name: str
    created_at: str
    updated_at: str


class CheckCustomerListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[CheckCustomerRow]
    total: int
    page: int
    total_pages: int


class CheckCustomerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    customer: CheckCustomerDetail


# ── Companies ──────────────────────────────────────────────


class CheckCompanyBody(_FeeFields):
    name:           str = Field(..., min_length=1, max_length=160)
    # 9-digit ABA routing number; the service checks its check digit.
    routing_number: str = Field("", pattern=r"^(\d{9})?$")
    account_number: str = Field("", pattern=r"^\d{0,20}$")
    address:        str = Field("", max_length=255)
    phone:          str = Field("", max_length=40)
    status:         PartyStatus = "normal"
    status_reason:  str = Field("", max_length=255)
    notes:          str = Field("", max_length=4000)

    @model_validator(mode="after")
    def _numbers_together(self) -> "CheckCompanyBody":
        if bool(self.routing_number) != bool(self.account_number):
            raise ValueError(
                "Enter both the routing and the account number, or neither.",
            )
        return self


class CheckCompanyRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    name: str
    routing_number: str
    # Masked to the last 4 digits.
    account_last4: str
    phone: str
    status: str
    home_store_name: str
    created_at: str


class CheckCompanyDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    name: str
    routing_number: str
    account_number: str
    address: str
    phone: str
    status: str
    status_reason: str
    fee_kind: str | None
    fee_value: float | None
    notes: str
    home_store_name: str
    created_at: str
    updated_at: str


class CheckCompanyListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[CheckCompanyRow]
    total: int
    page: int
    total_pages: int


class CheckCompanyResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    company: CheckCompanyDetail


# ── Cash a check ───────────────────────────────────────────

ReviewLevel = Literal["info", "warn", "approve", "block"]
CheckStatus = Literal["cashed", "declined", "voided"]


class CheckReviewBody(BaseModel):
    """What the cashier has typed so far; the answer is the fee and
    the review. Changes nothing."""
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    customer_id:  int | None = Field(None, ge=1)
    company_id:   int | None = Field(None, ge=1)
    check_number: str = Field("", max_length=20)
    check_date:   date | None = None
    amount:       float = Field(0, ge=0, le=MAX_MONEY)


class CheckFeeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str | None
    # Percent (1.5) or dollars, as on the settings page.
    value: float | None
    fee: float
    # customer, company or store: whose fee rule this is.
    source: str
    base_applied: bool


class CheckReviewItemOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    level: ReviewLevel
    count: int | None
    amount: float | None
    day: date | None


class CheckReviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fee: CheckFeeOut | None
    items: list[CheckReviewItemOut]
    today_count: int
    today_total: float


class CashCheckBody(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    customer_id:  int = Field(..., ge=1)
    company_id:   int = Field(..., ge=1)
    check_number: str = Field("", max_length=20)
    check_date:   date | None = None
    amount:       float = Field(..., gt=0, le=MAX_MONEY)
    # What the cashier charges; the suggested fee is saved beside it.
    fee:          float = Field(0, ge=0, le=MAX_MONEY)
    # Review codes the cashier ticked (warnings and approvals).
    acknowledged: list[str] = Field(default_factory=list, max_length=20)
    decision:     Literal["cash", "decline"] = "cash"
    reason:       str = Field("", max_length=255)
    micr:         str = Field("", max_length=120)

    @model_validator(mode="after")
    def _decline_reason(self) -> "CashCheckBody":
        if self.decision == "decline" and not self.reason.strip():
            raise ValueError("Say why the check is not accepted.")
        return self


class CashedCheckRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    store_name: str
    store_day: date
    created_at: str
    customer_id: int
    customer_name: str
    company_id: int
    company_name: str
    check_number: str
    check_date: date | None
    amount: float
    fee: float
    cash: float
    status: CheckStatus
    reason: str
    void_reason: str
    cashier_name: str
    warnings: list[str]
    approved: bool
    # A manager, at the store that cashed it, on that store day.
    can_void: bool


class CashedCheckResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    check: CashedCheckRow


class CashedCheckListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[CashedCheckRow]
    total: int
    page: int
    total_pages: int


class VoidCheckBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(..., min_length=1, max_length=255)


class CheckStatsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # store = this store; all = every store under the same owner.
    scope: Literal["store", "all"]
    count: int
    total: float
    biggest: float
    average: float
    last_day: date | None
    last_amount: float | None
    declined: int
    voided: int


class CheckActivityResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # "all" only when the owner has more than one store.
    stats: list[CheckStatsOut]
    recent: list[CashedCheckRow]


class CompanyCustomerRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    full_name: str
    status: str
    checks: int
    last_day: date


class CompanyCustomersResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[CompanyCustomerRow]


class CompanyLookupResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # None when no company with these numbers is on file.
    company: CheckCompanyDetail | None
