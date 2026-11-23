"""StoreBook — Requests.

Money crosses the wire in CENTS, like every other ledger endpoint.
The field list itself is not enumerated in the schema: it lives in
``FIELD_GROUPS`` on the model and is validated in the Service, so
adding a line to the sheet doesn't mean editing a Pydantic model
too (and can't half-land in one place but not the other).
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StoreBookFieldSpec(BaseModel):
    """One input on the sheet."""
    model_config = ConfigDict(extra="forbid")

    key: str
    label: str
    # Paired "# / $" inputs: the integer companion beside the money
    # box (money orders, transfers, bill pay, coupons, ATM).
    count_field: str | None = None
    # Fuel carries gallons beside the amount.
    gallons_field: str | None = None


class StoreBookSectionSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str
    label: str
    fields: list[StoreBookFieldSpec]


class StoreBookColumnSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    column: str
    label: str
    sections: list[StoreBookSectionSpec]


class StoreBookTotals(BaseModel):
    """The three running column totals plus the variance between
    two of them — the number the sheet exists to produce."""
    model_config = ConfigDict(extra="forbid")

    sales_cents: int
    tenders_cents: int
    deposit_cents: int
    over_short_cents: int


class StoreBookRegisterItem(BaseModel):
    """Something the register reported that sits on no line: a
    department number the store has not set up, a department whose
    type has no line, or a payment type the book does not know."""
    model_config = ConfigDict(extra="forbid")

    kind: Literal["department", "payment_type"]
    code: str
    name: str
    amount_cents: int


class StoreBookRegisterDay(BaseModel):
    """The register's day close for this day, for a store that has
    the register feed switched on.

    `pending` means the register holds figures this sheet has not
    taken yet; the page takes them (POST …/register) when the person
    may edit and the day is open. Times are naive UTC like every API
    timestamp; `period_*` are the register's own clock read in the
    store's zone.
    """
    model_config = ConfigDict(extra="forbid")

    has_data: bool
    ready: bool
    pending: bool
    # "" | "waiting" | "departments" | "tax_split"
    problem: str
    period_start: str | None
    period_end: str | None
    received_at: str | None
    unmapped: list[StoreBookRegisterItem]
    unplaced: list[StoreBookRegisterItem]


class StoreBookDayResponse(BaseModel):
    """One day's sheet.

    `values` and `counts` are keyed by field key; `originals` holds
    only the fields an import supplied, so the SPA renders the
    register's figure exactly where there is one. `register_day` is null
    for a store without the register feed.
    """
    model_config = ConfigDict(extra="forbid")

    entry_date: str
    store_id: int
    values: dict[str, int]
    counts: dict[str, float]
    originals: dict[str, int]
    totals: StoreBookTotals
    notes: str
    is_locked: bool
    locked_at: str | None
    updated_at: str | None
    # The layout, served with the data so the page can't hold a
    # stale copy of the field list.
    layout: list[StoreBookColumnSpec]
    register_day: StoreBookRegisterDay | None


class StoreBookUpdateRequest(BaseModel):
    """Partial update — only the fields the operator touched.

    Unknown keys are rejected by the Service rather than dropped
    here, so a typo surfaces as an error instead of a save that
    silently discarded a number.
    """
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    values: dict[str, int] | None = None
    counts: dict[str, float] | None = None
    notes: str | None = Field(None, max_length=2000)


class StoreBookLockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    locked: bool


class StoreBookRestoreRequest(BaseModel):
    """Take the register's number back for one field."""
    model_config = ConfigDict(extra="forbid")

    field_key: str = Field(..., min_length=1, max_length=40)


class StoreBookMonthRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entry_date: str
    sales_cents: int
    tenders_cents: int
    deposit_cents: int
    over_short_cents: int
    is_locked: bool


class StoreBookMonthResponse(BaseModel):
    """Calendar month: one row per day that has a sheet, plus the
    month's rolled-up totals for the header cards."""
    model_config = ConfigDict(extra="forbid")

    year: int
    month: int
    rows: list[StoreBookMonthRow]
    total_sales_cents: int
    total_fuel_gallons: float
    total_fuel_cents: int


__all__ = [
    "StoreBookColumnSpec", "StoreBookDayResponse", "StoreBookFieldSpec",
    "StoreBookLockRequest", "StoreBookMonthResponse", "StoreBookMonthRow",
    "StoreBookRegisterDay", "StoreBookRegisterItem",
    "StoreBookRestoreRequest", "StoreBookSectionSpec", "StoreBookTotals",
    "StoreBookUpdateRequest",
]
