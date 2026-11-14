"""ReturnChecks — Pydantic schemas."""
from pydantic import BaseModel, ConfigDict, Field


class ReturnCheckRow(BaseModel):
    """One bounced-check row. Mirrors the columns the legacy
    /return-checks list page renders."""

    model_config = ConfigDict(extra="forbid")

    id: int
    bounced_on: str  # YYYY-MM-DD
    customer_name: str
    company_name: str = ""
    check_number: str = ""
    payer_bank: str = ""
    amount: float
    return_check_fee: float = 0.0
    status: str
    status_changed_on: str = ""  # "" when pending
    notes: str = ""
    recovered_total: float = 0.0
    payment_count: int = 0
    # The batch the check came back in (None = not in a batch) and
    # that batch's bank reference, for the list and the form.
    batch_id: int | None = None
    batch_reference: str = ""
    routing_number: str = ""
    account_number: str = ""


class ReturnCheckListResponse(BaseModel):
    """Every check, or one page when the list is asked for a
    ``page``; the envelope fields are filled either way."""
    model_config = ConfigDict(extra="forbid")

    rows: list[ReturnCheckRow]
    total: int = 0
    page: int = 1
    total_pages: int = 1


class ReturnCheckResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    return_check: ReturnCheckRow


class ReturnCheckWriteRequest(BaseModel):
    """POST/PUT body. Status transitions go through dedicated
    endpoints, not via this schema."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    bounced_on:    str   = Field(..., min_length=10, max_length=10)
    customer_name: str   = Field(..., min_length=1, max_length=120)
    company_name:  str   = Field(..., min_length=1, max_length=120)
    check_number:  str   = Field("", max_length=40)
    payer_bank:    str   = Field("", max_length=120)
    amount:        float = Field(..., gt=0)
    return_check_fee: float = Field(0.0, ge=0)
    notes:         str   = Field("", max_length=2000)
    # Optional, and only applied when sent: a page that predates
    # batches leaves a check's batch / routing / account untouched.
    # A check in a batch takes the batch's returned date.
    batch_id:      int | None = Field(None, ge=1)
    routing_number: str  = Field("", pattern=r"^([0-9]{9})?$")
    account_number: str  = Field("", pattern=r"^[0-9]{0,20}$")


class ReturnCheckBatchCheckRequest(BaseModel):
    """One check on the New batch form. The returned date is the
    batch's."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    customer_name: str   = Field(..., min_length=1, max_length=120)
    company_name:  str   = Field(..., min_length=1, max_length=120)
    check_number:  str   = Field("", max_length=40)
    payer_bank:    str   = Field("", max_length=120)
    routing_number: str  = Field("", pattern=r"^([0-9]{9})?$")
    account_number: str  = Field("", pattern=r"^[0-9]{0,20}$")
    amount:        float = Field(..., gt=0)
    return_check_fee: float = Field(0.0, ge=0)
    notes:         str   = Field("", max_length=2000)


class ReturnCheckBatchCreateRequest(BaseModel):
    """POST /return-checks/batches: the batch and its checks at once."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    returned_on: str = Field(..., min_length=10, max_length=10)
    reference:   str = Field("", max_length=80)
    notes:       str = Field("", max_length=2000)
    checks: list[ReturnCheckBatchCheckRequest] = Field(..., min_length=1, max_length=50)


class ReturnCheckBatchUpdateRequest(BaseModel):
    """PUT /return-checks/batches/{id}: the batch's own fields. A new
    date moves every check in the batch."""

    model_config = ConfigDict(extra="forbid")

    returned_on: str = Field(..., min_length=10, max_length=10)
    reference:   str = Field("", max_length=80)
    notes:       str = Field("", max_length=2000)


class ReturnCheckBatchRow(BaseModel):
    """One returned batch with its totals (worked out from its checks)."""

    model_config = ConfigDict(extra="forbid")

    id: int
    returned_on: str  # YYYY-MM-DD
    reference: str = ""
    notes: str = ""
    check_count: int = 0
    amount_total: float = 0.0
    fee_total: float = 0.0
    recovered_total: float = 0.0
    open_count: int = 0
    companies: list[str] = []


class ReturnCheckBatchListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[ReturnCheckBatchRow]
    total: int = 0
    page: int = 1
    total_pages: int = 1


class ReturnCheckBatchResponse(BaseModel):
    """One batch and its checks."""

    model_config = ConfigDict(extra="forbid")

    batch: ReturnCheckBatchRow
    checks: list[ReturnCheckRow] = []


class ReturnCheckPartyRow(BaseModel):
    """A company or customer on the By company / By customer lists."""

    model_config = ConfigDict(extra="forbid")

    key: str             # the grouping key; pass back as ?company= / ?customer=
    name: str            # the spelling on the most recent check
    check_count: int
    amount_total: float
    owed_total: float
    open_count: int
    lost_count: int
    lost_total: float
    last_returned_on: str = ""
    routing_number: str = ""


class ReturnCheckPartyListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[ReturnCheckPartyRow]
    total: int = 0
    page: int = 1
    total_pages: int = 1


class ReturnCheckPaymentRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    return_check_id: int
    amount: float
    paid_on: str
    method: str = ""
    notes: str = ""


class ReturnCheckPaymentsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payments: list[ReturnCheckPaymentRow]


class ReturnCheckPaymentResponse(BaseModel):
    """Single-row payload returned by POST/DELETE payment endpoints.
    Includes the refreshed parent ``return_check`` so the client
    can update the recovered_total + status pill in one round-trip."""

    model_config = ConfigDict(extra="forbid")

    payment: ReturnCheckPaymentRow | None = None
    return_check: ReturnCheckRow


class ReturnCheckPaymentWriteRequest(BaseModel):
    """Body for ``POST /return-checks/{id}/payments``.

    ``paid_on`` is the YYYY-MM-DD the cashier received the
    installment; the matching ``DailyLineItem`` auto-creates with
    this report_date. ``method`` is free-text but the SPA's form
    constrains it to ``cash / check / zelle / wire / money_order /
    other`` for consistency.
    """

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    paid_on: str    = Field(..., min_length=10, max_length=10)
    amount:  float  = Field(..., gt=0)
    method:  str    = Field("", max_length=20)
    note:    str    = Field("", max_length=200)


__all__ = [
    "ReturnCheckBatchCheckRequest",
    "ReturnCheckBatchCreateRequest",
    "ReturnCheckBatchListResponse",
    "ReturnCheckBatchResponse",
    "ReturnCheckBatchRow",
    "ReturnCheckBatchUpdateRequest",
    "ReturnCheckPartyListResponse",
    "ReturnCheckPartyRow",
    "ReturnCheckListResponse",
    "ReturnCheckPaymentResponse",
    "ReturnCheckPaymentRow",
    "ReturnCheckPaymentWriteRequest",
    "ReturnCheckPaymentsResponse",
    "ReturnCheckResponse",
    "ReturnCheckRow",
    "ReturnCheckWriteRequest",
]
