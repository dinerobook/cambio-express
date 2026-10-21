"""Pydantic schemas for the bank-transactions list endpoint."""
from datetime import date

from pydantic import BaseModel, ConfigDict, Field


class MatchedEntry(BaseModel):
    """A daily book entry a bank row is matched to (or could be)."""

    model_config = ConfigDict(extra="forbid")

    id: int
    report_date: date
    kind: str
    kind_label: str
    amount: float
    note: str = ""


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
    # The day the operator (or a rule's offset) chose for this row,
    # ISO date, "" when it books on the bank's own date. Distinct
    # from `booked_on`: a row can carry a chosen day while its
    # booking is skipped because the day is locked.
    report_date_override: str = ""
    # `posted_at`'s date — what the row books on with no override.
    # The SPA shows it as the "use the bank's date" choice.
    bank_date: str = ""
    # Where this money stands against the daily book (only when the
    # store has matching on; "" otherwise and for P&L / other tags):
    # added | matched | suggested | not_on_books | dismissed.
    books_status: str = ""
    matched_entries: list[MatchedEntry] = Field(default_factory=list)
    suggestion_count: int = 0
    dismissed_at: str = ""


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
    # The store's matching switch, and its store-wide counts (all
    # zero when the switch is off).
    matching_enabled: bool = False
    books_counts: "BooksCounts | None" = None


class BooksCounts(BaseModel):
    """Store-wide: how many bank rows are on the books, matched,
    still need a person, or were dismissed."""

    model_config = ConfigDict(extra="forbid")

    added: int = 0
    matched: int = 0
    to_review: int = 0
    dismissed: int = 0


class CategorizeRequest(BaseModel):
    """POST body for /bank/transactions/{txn_id}/categorize.

    `target_kind` is any slug `GET /bank/categories` lists for the
    store (a daily-book kind such as "check_deposit", a `pl_*`
    monthly line, or a non-posting tag such as "bank_charge_230").
    Unknown slugs are a 422.

    `post_to_daily=False` keeps the assignment metadata-only and
    skips creating the matching DailyLineItem (used when the
    operator wants the tag without a daily-book mirror).

    `report_date` (ISO date) is the day the line lands on, instead
    of the bank's posting date — a remote deposit the bank posts
    the next morning, or a Saturday deposit the bank posts on
    Monday, both belong on the earlier day's close-out. It is
    tri-state on the wire, read off `model_fields_set`:

      * omitted — keep whatever day the row already carries;
      * a date  — book on that day and remember it;
      * `null`  — clear the choice, back to the bank's date.

    Booking onto a locked day is a 409."""

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


class MatchCandidateRow(BaseModel):
    """One answer to "which entry is this bank row": one entry, or
    several same-day entries of one kind that add up to it."""

    model_config = ConfigDict(extra="forbid")

    line_ids: list[int]
    report_date: date
    kind: str
    kind_label: str
    entries: list[MatchedEntry] = Field(default_factory=list)
    by_check_number: bool = False
    # Bank date minus the entry's day: 2 = the bank posted it two
    # days after the day it was typed on.
    days_from_bank: int = 0


class MatchCandidatesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidates: list[MatchCandidateRow] = Field(default_factory=list)


class MatchLinesRequest(BaseModel):
    """POST body for match ("Yes, same money") and reject ("No,
    different"): the entries in question."""

    model_config = ConfigDict(extra="forbid")

    line_ids: list[int] = Field(..., min_length=1, max_length=4)


class DismissRequest(BaseModel):
    """Dismiss bank rows as already handled: the ticked `ids`, or
    every row still needing review posted on or before `before`.
    Exactly one of the two."""

    model_config = ConfigDict(extra="forbid")

    ids: list[int] = Field(default_factory=list, max_length=500)
    before: date | None = None


class DismissResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dismissed: int = 0
    # Rows already on the books (added or matched) are never
    # dismissed — there is nothing left to handle.
    skipped: int = 0


class UseEntryRequest(BaseModel):
    """Keep the typed entry: remove the one the bank added and
    match the bank row to the typed one."""

    model_config = ConfigDict(extra="forbid")

    line_id: int = Field(..., ge=1)


class PossibleDoubleRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transaction: BankTransactionRow
    bank_entry: MatchedEntry
    typed_entry: MatchedEntry


class PossibleDoublesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[PossibleDoubleRow] = Field(default_factory=list)


class ReconcileRunResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    matched: int = 0


BankTransactionListResponse.model_rebuild()
