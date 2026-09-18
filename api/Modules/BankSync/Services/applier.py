"""Bank-rule application orchestrator.

Runs the full rule chain (operator `BankRule` → platform-managed
built-in) against an uncategorised bank transaction and tags it.

Sits one layer above the matcher + categorize Services:

  matcher.find_matching_rule    → operator BankRule lookup
  builtin_rules.match_builtin_  → platform built-in lookup
  categorize.categorize_        → write the slug + maybe book a
                                   DailyLineItem

`apply_rules_to_uncategorized_row` is idempotent — rows that
already have a `category_slug` are left untouched so operator
overrides survive a re-sync.

A rule may also carry `post_date_offset_days` — the recurring
version of "this posts a day late": the booked line lands that many
days from the bank's date instead of on it. It only changes which
day is written, never whether one is.

`allow_auto_post` controls whether a matched operator rule with
`auto_post=True` also books a `DailyLineItem`:
  - `True`  for freshly-inserted rows (operator's expressed
            intent on new data) and for an explicit "apply this
            rule now" from the rules page.
  - `False` when backfilling historical rows during a sync (the
            daily book may already be reconciled — let the
            operator post manually or apply the rule on purpose).

A locked day never gets a line: the tag is kept, the booking is
skipped, and the outcome says so, so the transactions page can
show "day locked" instead of silently doing nothing.

Built-in rules NEVER post to the daily book regardless — the
`post_to_daily=False` is hard-coded for them per CLAUDE.md.

Caller commits.
"""
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlalchemy.orm import Session

from api.Modules.BankSync.Services.builtin_rules import (
    match_builtin_bank_rule,
)
from api.Modules.BankSync.Services.categorize import (
    DailyBookLockedError,
    bank_date_for,
    categorize_transaction,
)
from api.Modules.BankSync.Services.categories import (
    is_daily_book_kind,
)
from api.Modules.BankSync.Services.matcher import (
    find_matching_rule,
    rule_matches,
)


@dataclass(frozen=True)
class ApplyOutcome:
    tagged: bool
    booked: bool = False
    locked_skipped: bool = False


def rule_booking_date(rule: Any, row: Any) -> date | None:
    """The day `rule` wants this row booked on, or None for the
    bank's own date. A rule cannot name an absolute day — it fires
    on rows the operator has not seen yet — so it carries a shift
    in days from the bank's date instead: -1 for the remote deposit
    the bank posts the next morning."""
    offset = int(rule.post_date_offset_days or 0)
    if offset == 0:
        return None
    return bank_date_for(row) + timedelta(days=offset)


def _apply_rule(db: Session, row: Any, rule: Any, *, allow_auto_post: bool) -> ApplyOutcome:
    post = bool(rule.auto_post and allow_auto_post)
    # The shifted day is the rule's intent, so it is stored on the
    # row (`report_date_explicit`) even when the booking is skipped:
    # unlocking the day later and re-tagging still lands on the day
    # the operator meant.
    booking_date = rule_booking_date(rule, row)
    explicit = booking_date is not None
    try:
        categorize_transaction(
            db, row, rule.target_kind, rule=rule,
            post_to_daily=post, report_date=booking_date,
            report_date_explicit=explicit,
            is_daily_book_kind=is_daily_book_kind,
        )
    except DailyBookLockedError:
        # Keep the tag, skip the line: a closed day is not ours to
        # reopen from a bank feed.
        categorize_transaction(
            db, row, rule.target_kind, rule=rule,
            post_to_daily=False, report_date=booking_date,
            report_date_explicit=explicit,
            is_daily_book_kind=is_daily_book_kind,
        )
        return ApplyOutcome(tagged=True, booked=False, locked_skipped=True)
    return ApplyOutcome(tagged=True, booked=bool(row.daily_line_item_id))


def apply_rules_to_uncategorized_row(
    db: Session, row: Any, account: Any, *, allow_auto_post: bool,
) -> bool:
    """Apply the rule chain to `row`. Returns True iff the row
    was tagged.

    Order matters:
      1. Operator BankRule chain (lowest priority first). If a
         rule matches, tag the row + maybe book a DailyLineItem
         when `auto_post AND allow_auto_post`.
      2. Built-in (platform-managed) rule chain. If a built-in
         matches, tag the row WITHOUT posting to the daily book.
      3. Otherwise leave the row uncategorised.
    """
    if row.category_slug:
        return False

    rule = find_matching_rule(db, row.store_id, row)
    if rule is not None:
        return _apply_rule(db, row, rule, allow_auto_post=allow_auto_post).tagged

    builtin = match_builtin_bank_rule(row, account)
    if builtin:
        categorize_transaction(
            db, row, builtin,
            rule=None,
            post_to_daily=False,
            is_daily_book_kind=is_daily_book_kind,
        )
        return True

    return False


@dataclass(frozen=True)
class RuleApplyReport:
    """What applying ONE rule to the store's existing uncategorised
    rows did — the numbers the operator sees in the toast."""
    tagged: int = 0
    booked: int = 0
    locked_skipped: int = 0


def apply_rule_to_existing(
    db: Session, rule: Any, *, allow_auto_post: bool = True,
) -> RuleApplyReport:
    """Run one rule over every still-uncategorised transaction in
    its store. This is the "apply now" the operator asks for when
    they create a rule from a transaction they have already seen —
    unlike the sync backfill it books by default, because the
    operator just said so. Locked days are still skipped.

    Only uncategorised rows are touched: a rule never overrides a
    tag someone set by hand. Caller commits.
    """
    from sqlalchemy import or_

    from api.Modules.BankSync.Models import BankTransaction

    if not rule.enabled:
        return RuleApplyReport()
    rows = (
        db.query(BankTransaction)
          .filter(
              BankTransaction.store_id == rule.store_id,
              or_(
                  BankTransaction.category_slug.is_(None),
                  BankTransaction.category_slug == "",
              ),
          )
          .order_by(BankTransaction.posted_at.asc(), BankTransaction.id.asc())
          .all()
    )
    tagged = booked = locked = 0
    for row in rows:
        if not rule_matches(rule, row):
            continue
        out = _apply_rule(db, row, rule, allow_auto_post=allow_auto_post)
        tagged += 1
        booked += int(out.booked)
        locked += int(out.locked_skipped)
    return RuleApplyReport(tagged=tagged, booked=booked, locked_skipped=locked)
