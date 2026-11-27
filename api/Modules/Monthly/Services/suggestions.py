"""What a bank row to review probably is — the Transactions tab's
suggestions (Monthly INVARIANTS "Suggestions").

Read-only: nothing is tagged until a person accepts (one row, or
"Accept all"). Two sources, first one wins:

1. **history** — the store tagged a row with the same words before
   (the description without its numbers, the way "Make a rule"
   reads it: "SQUARE INC 8834412" and "SQUARE INC 9921" are the same
   payee) and money going the same way: the newest such tag;
2. **template** — a platform rule template (Platform → Rule
   templates) fires on the row, though the store has not made it a
   rule. Shown without anyone pressing "Use" (owner, 2026-11-27).

A suggestion is offered only when the store may pick that category
(`is_valid_bank_category`).
"""
from __future__ import annotations

import re
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

from sqlalchemy.orm import Session

# How far back the store's own tags are read.
HISTORY_DAYS = 400

_DATE = re.compile(r"\b\d{1,4}[/:.-]\d{1,2}([/:.-]\d{1,4})?\b")
_HAS_DIGIT = re.compile(r"\S*\d\S*")
_SEPARATORS = re.compile(r"[#*|_]+")
_SPACES = re.compile(r"\s+")
_TRAILING = re.compile(r"[\s\-–—:,.]+$")


def description_words(description: str | None) -> str:
    """The description without what changes every time (dates,
    reference numbers, card suffixes), upper-cased — the same reading
    as the SPA's `matchTextFromDescription`. Falls back to the whole
    description when nothing but numbers is left."""
    raw = (description or "").strip()
    text = _DATE.sub(" ", raw)
    text = _HAS_DIGIT.sub(" ", text)
    text = _SEPARATORS.sub(" ", text)
    text = _TRAILING.sub("", _SPACES.sub(" ", text).strip())
    return (text or raw).upper()


def _key(t: Any) -> tuple[str, bool]:
    return description_words(t.description), int(t.amount_cents or 0) > 0


def suggestions_for(
    db: Session, store_id: int, txns: list[Any],
) -> dict[int, tuple[str, str]]:
    """``{txn_id: (slug, source)}`` for the rows given (rows to
    review), source ``history`` or ``template``."""
    from api.Core.Clock import utc_now
    from api.Modules.BankSync.Models import BankRuleTemplate, BankTransaction
    from api.Modules.BankSync.Services.categories import is_valid_bank_category
    from api.Modules.BankSync.Services.matcher import rule_matches

    if not txns:
        return {}
    valid: dict[str, bool] = {}

    def ok(slug: str) -> bool:
        if slug not in valid:
            valid[slug] = bool(slug) and is_valid_bank_category(db, slug, store_id)
        return valid[slug]

    wanted = {_key(t) for t in txns}
    since = utc_now() - timedelta(days=HISTORY_DAYS)
    history: dict[tuple[str, bool], str] = {}
    tagged = (
        db.query(BankTransaction)
          .filter(
              BankTransaction.store_id == store_id,
              BankTransaction.category_slug.isnot(None),
              BankTransaction.category_slug != "",
              BankTransaction.dismissed_at.is_(None),
              BankTransaction.posted_at >= since,
          )
          .order_by(BankTransaction.posted_at.desc(), BankTransaction.id.desc())
    )
    for t in tagged:
        k = _key(t)
        if k in wanted and k not in history and ok(str(t.category_slug)):
            history[k] = str(t.category_slug)

    templates = [
        SimpleNamespace(
            enabled=True, desc_match_type=tp.desc_match_type,
            desc_match_value=tp.desc_match_value, sign_filter=tp.sign_filter,
            amount_min_cents=tp.amount_min_cents,
            amount_max_cents=tp.amount_max_cents, account_filter_id=None,
            target_kind=str(tp.target_kind),
        )
        for tp in db.query(BankRuleTemplate)
                    .filter(BankRuleTemplate.enabled.is_(True))
                    .order_by(BankRuleTemplate.id)
    ]
    out: dict[int, tuple[str, str]] = {}
    for t in txns:
        slug = history.get(_key(t))
        if slug:
            out[int(t.id)] = (slug, "history")
            continue
        for tp in templates:
            if rule_matches(tp, t) and ok(tp.target_kind):
                out[int(t.id)] = (tp.target_kind, "template")
                break
    return out
