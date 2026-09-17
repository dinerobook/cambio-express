"""Pydantic schemas for the bank-transactions list endpoint."""
from datetime import date

from pydantic import BaseModel, ConfigDict, Field


class BankTransactionRow(BaseModel):
    """One row in the /bank/transactions list. Wire shape mirrors
    what the legacy template renders — id, date, label, amount in
    dollars, category, etc."""

    model_config = ConfigDict(extra="forbid")

    id: int
    posted_at: str = ""  # ISO datetime, "" if pending
    description: str = ""
    amount_cents: int
    amount: float  # amount_cents / 100, signed
    currency: str = "usd"
    status: str = "posted"
    category_slug: str = ""
    account_id: int
    account_label: str = ""  # nickname or ••last4
    # Set when the category booked a DailyLineItem: the line's id and
    # the day it landed on (ISO date) so the SPA can link to that
    # day's book. Empty / None when the tag is metadata-only.
    daily_line_item_id: int | None = None
    booked_on: str = ""


class BankTransactionListResponse(BaseModel):
    """Paginated response envelope. Mirrors the partial-render JSON
    shape the legacy /bank/transactions page already returns."""

    model_config = ConfigDict(extra="forbid")

    rows: list[BankTransactionRow] = Field(default_factory=list)
    total: int
    page: int
    per_page: int
    total_pages: int
    page_total_cents: int
    uncategorized_count: int


class CategorizeRequest(BaseModel):
    """POST body for /bank/transactions/{txn_id}/categorize.

    `target_kind` is any slug `GET /bank/categories` lists for the
    store (a daily-book kind such as "check_deposit", a `pl_*`
    monthly line, or a non-posting tag such as "bank_charge_230").
    Unknown slugs are a 422.

    `post_to_daily=False` keeps the assignment metadata-only and
    skips creating the matching DailyLineItem (used when the
    operator wants the tag without a daily-book mirror).
    `report_date` (ISO date) overrides the day the line lands on —
    for a remote deposit the bank posts the next morning that
    belongs on the prior day's close-out. Booking onto a locked
    day is a 409."""

    model_config = ConfigDict(extra="forbid")

    target_kind: str = Field(..., min_length=1, max_length=60)
    post_to_daily: bool = True
    report_date: date | None = None


class CategorizeResponse(BaseModel):
    """Returned from categorize / uncategorize. Echoes the row's
    new category state so the SPA can update without re-fetching."""

    model_config = ConfigDict(extra="forbid")

    transaction: BankTransactionRow


class BankCategoryOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: str
    label: str


class BankCategoryGroup(BaseModel):
    """One `<optgroup>` of the category picker. `posts_to_daily`
    tells the SPA which group books a line on the daily book so it
    can show the booking controls only where they apply."""

    model_config = ConfigDict(extra="forbid")

    label: str
    posts_to_daily: bool = False
    options: list[BankCategoryOption] = Field(default_factory=list)


class BankCategoriesResponse(BaseModel):
    """GET /bank/categories — the store's category picker, grouped
    the way the operator should read it (daily book, monthly P&L,
    other). The server is the only source of this list: the SPA
    must not hard-code slugs."""

    model_config = ConfigDict(extra="forbid")

    groups: list[BankCategoryGroup] = Field(default_factory=list)
