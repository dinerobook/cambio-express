"""The condition checks a bank rule and a rule template share.

Cross-field invariants Pydantic ``Field()`` cannot express. Raises
422 with a ``field`` hint so the SPA can highlight the input. One
copy, used by the store's rule routes and the superadmin's template
routes, so a template a store copies can always be saved as a rule.
"""
from typing import Protocol

from fastapi import HTTPException


class RuleConditions(Protocol):
    desc_match_type: str
    desc_match_value: str
    sign_filter: str
    amount_min_cents: int | None
    amount_max_cents: int | None


def validate_rule_conditions(
    body: RuleConditions, *, require_condition: bool = True,
    account_filter_id: int | None = None,
) -> None:
    """``require_condition`` is on for create (an unconditional rule
    tags everything); an update of a pre-existing rule keeps
    whatever shape it already had. ``account_filter_id`` counts as a
    condition for a store rule; a template has no account."""
    # A value without a type defaults to "contains" — the SPA's
    # quick "Make a rule" form only asks for the words.
    if body.desc_match_value.strip() and not body.desc_match_type:
        body.desc_match_type = "contains"
    # If desc_match_type is set, desc_match_value must be non-empty.
    if body.desc_match_type and not body.desc_match_value.strip():
        raise HTTPException(
            status_code=422,
            detail={
                "field": "desc_match_value",
                "message": "Description match value is required when "
                           "match type is set.",
            },
        )
    # amount_min must be ≤ amount_max if both set.
    if (
        body.amount_min_cents is not None
        and body.amount_max_cents is not None
        and body.amount_min_cents > body.amount_max_cents
    ):
        raise HTTPException(
            status_code=422,
            detail={
                "field": "amount_max_cents",
                "message": "Max amount must be ≥ min amount.",
            },
        )
    # An empty rule matches every transaction — always a mistake.
    if (
        require_condition
        and not body.desc_match_type and not body.sign_filter
        and body.amount_min_cents is None and body.amount_max_cents is None
        and account_filter_id is None
    ):
        raise HTTPException(
            status_code=422,
            detail={
                "field": "desc_match_value",
                "message": "Set at least one condition (description, "
                           "sign, amount, or account).",
            },
        )
