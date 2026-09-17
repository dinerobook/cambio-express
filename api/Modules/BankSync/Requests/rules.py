"""Pydantic schemas for the bank-rules list endpoint."""
from pydantic import BaseModel, ConfigDict, Field


class BankRuleRow(BaseModel):
    """One operator-managed BankRule. Same fields the
    /bank/rules HTML page exposes; the React rules-manager UI will
    consume the same shape."""

    model_config = ConfigDict(extra="forbid")

    id: int
    enabled: bool
    priority: int
    desc_match_type: str = ""
    desc_match_value: str = ""
    sign_filter: str = ""
    amount_min_cents: int | None = None
    amount_max_cents: int | None = None
    account_filter_id: int | None = None
    account_filter_label: str = ""  # nickname or ••last4 of the account
    target_kind: str
    auto_post: bool = True
    description: str = ""
    match_count: int = 0
    last_matched_at: str = ""  # ISO datetime, "" if never matched


class BankRuleListResponse(BaseModel):
    """Envelope for the /bank/rules read endpoint. Order matches the
    Repository: priority asc, id asc tie-break — the same order the
    auto-categorize sync walks them in, so what the UI shows is the
    actual evaluation order."""

    model_config = ConfigDict(extra="forbid")

    rows: list[BankRuleRow] = Field(default_factory=list)
    total: int


class BankRuleWriteRequest(BaseModel):
    """POST/PUT body for bank rule CRUD. Mirrors the legacy
    /bank/rules/new + /bank/rules/<id>/edit forms.

    `desc_match_type` must be "" (skip the description filter
    entirely) or one of `DESC_MATCH_TYPES` in
    `Services/matcher.py` (`contains` / `starts_with` / `ends_with`
    / `equals` / `regex`). Similarly `sign_filter` is "" /
    `credit` / `debit`. `amount_min_cents` / `amount_max_cents`
    are absolute cents (positive integers); None on either side
    means unbounded. `target_kind` is required — what category the
    matching txn gets tagged with.

    `apply_to_existing` (create only) runs the new rule over the
    store's still-uncategorised transactions right away, booking
    daily-book lines when `auto_post` is on. The counts come back
    in `BankRuleResponse.applied`."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    priority: int = Field(100, ge=0, le=10000)
    desc_match_type: str = Field(
        "", pattern="^(|contains|starts_with|ends_with|equals|regex)$",
    )
    desc_match_value: str = Field("", max_length=500)
    sign_filter: str = Field("", pattern="^(|credit|debit)$")
    amount_min_cents: int | None = Field(None, ge=0)
    amount_max_cents: int | None = Field(None, ge=0)
    account_filter_id: int | None = None
    target_kind: str = Field(..., min_length=1, max_length=40)
    auto_post: bool = True
    description: str = Field("", max_length=200)
    apply_to_existing: bool = False


class BankRuleApplyReport(BaseModel):
    """What applying a rule to the store's existing uncategorised
    rows did. `locked_skipped` rows were tagged but not booked
    because their day's book is locked."""

    model_config = ConfigDict(extra="forbid")

    tagged: int = 0
    booked: int = 0
    locked_skipped: int = 0


class BankRuleResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rule: BankRuleRow
    # Present when the request asked to apply the rule to existing
    # rows (create with `apply_to_existing`, or POST .../apply).
    applied: BankRuleApplyReport | None = None


class BankRuleReorderRequest(BaseModel):
    """POST body for /bank/rules/reorder — every rule id of the
    store in the order they should evaluate (top first). Rules are
    evaluated first-match-wins, so the order IS the semantics; the
    server rewrites `priority` as 10, 20, 30… in this order."""

    model_config = ConfigDict(extra="forbid")

    ids: list[int] = Field(..., min_length=1)


class BankRuleToggleRequest(BaseModel):
    """POST body for /bank/rules/{id}/toggle. Explicit `enabled`
    so callers don't accidentally flip the wrong way when their
    cached row is stale."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool
