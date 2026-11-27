"""Schemas for the Monthly P&L's Transactions tab
(`GET /monthly/{year}/{month}/transactions`, Services/ledger.py)."""
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

PLTransactionView = Literal["review", "in_pl", "not_pl", "all"]
PLTransactionSource = Literal[
    "bank", "entry", "day", "service", "money_order_charges",
    "returned_checks", "typed",
]
PLTransactionStatus = Literal[
    "rule", "person", "added", "matched", "to_review", "not_in_pl",
    "daily", "returned_checks", "typed", "bank_wins", "typed_wins",
]


class PLTransactionRow(BaseModel):
    """One dollar of the month, listed once. `amount` is what the row
    adds to `line` (signed: a short or a refund is negative); a row
    that does not count (`counted` false) shows its size. Bank rows
    carry `txn_id` (categorize through the Bank endpoints) and the
    bank's signed `bank_amount`."""

    model_config = ConfigDict(extra="forbid")

    key: str
    source: PLTransactionSource
    day: date | None
    description: str
    amount: float
    line: str | None
    bucket: Literal["income", "expense"] | None
    status: PLTransactionStatus
    counted: bool
    bank_amount: float | None
    txn_id: int | None
    category_slug: str
    rule_id: int | None
    item_kind: str
    book: Literal["msb", "store", ""]
    account_label: str
    report_date_override: date | None
    bank_date: date | None
    booked_on: date | None
    # What a row to review probably is (Services/suggestions.py):
    # the store's own earlier tag for the same words, else a platform
    # rule template. "" when nothing fits.
    suggested_slug: str
    suggested_source: Literal["history", "template", ""]
    # A cash / check expense or purchase entry (Services/
    # entry_categories.py): its id, and the expense line it was put
    # on ("" = its kind's own line). Null for every other row.
    entry_id: int | None = None
    entry_category: str = ""


class PLTransactionCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    review: int
    in_pl: int
    not_pl: int
    all: int


class PLAcceptRequest(BaseModel):
    """`POST /monthly/{year}/{month}/transactions/accept`: tag rows to
    review with their suggestion. `txn_ids` limits it to those rows
    (one row's ✓); empty takes every suggestion of the month ("Accept
    all")."""

    model_config = ConfigDict(extra="forbid")

    txn_ids: list[int] = Field(default_factory=list, max_length=500)
    # Daily entries to put on their suggested line (needs
    # `monthly.update`). Both lists empty = every suggestion.
    entry_ids: list[int] = Field(default_factory=list, max_length=500)


class PLAcceptResponse(BaseModel):
    """What "Accept" did. A row left alone stays to review: its day is
    locked (`locked`), or a daily book check may be the same money
    (`maybe_in_daily_book`, decided one row at a time)."""

    model_config = ConfigDict(extra="forbid")

    accepted: int
    locked: int
    maybe_in_daily_book: int


class PLEntryTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: str
    label: str


class PLTransactionsResponse(BaseModel):
    """The tab's page: the `api.Core.Pagination` envelope plus the
    month's counts per view (unfiltered), its totals (the statement's
    own) and how complete it is."""

    model_config = ConfigDict(extra="forbid")

    rows: list[PLTransactionRow]
    total: int
    page: int
    total_pages: int
    counts: PLTransactionCounts
    total_income: float
    total_expenses: float
    net_profit: float
    days_entered: int
    days_in_month: int
    # Rows to review this month with a suggestion, plus daily entries
    # with one (the "Accept all" button's count).
    suggested: int
    # Where a daily entry can go (the entry row's picker): the
    # store's expense lines and expense categories, its own names.
    entry_targets: list[PLEntryTarget] = []


class PLEntryCategoryRequest(BaseModel):
    """`PUT /monthly/entries/{id}/category`: the expense line a daily
    entry counts on. "" puts it back on its kind's own line."""

    model_config = ConfigDict(extra="forbid")

    slug: str = Field("", max_length=40)


class PLEntryCategoryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entry_id: int
    entry_category: str


# ── A store's own P&L categories ────────────────────────────


class PLCategoryRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    slug: str
    name: str
    section: Literal["income", "expense"]
    archived: bool
    # Bank rows on it, every month.
    in_use: int


class PLCategoryListResponse(BaseModel):
    """`enabled` false (no `pl_transactions`): the store has no
    categories of its own and `rows` is empty."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool
    rows: list[PLCategoryRow]


class PLCategoryCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., max_length=200)
    section: Literal["income", "expense"]


class PLCategoryRenameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., max_length=200)


class PLCategoryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: PLCategoryRow
