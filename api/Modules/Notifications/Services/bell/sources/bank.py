"""Bank item: transactions that still need a person."""
from __future__ import annotations

from sqlalchemy import or_

from api.Modules.BankSync.Models import BankTransaction
from api.Modules.BankSync.Services import reconcile
from api.Modules.Notifications.Services.bell.types import (
    BellContext, BellItem, BellSource,
)


def collect_to_check(ctx: BellContext) -> list[BellItem]:
    """With bank matching on, the Bank page's own "review" count (the
    same clause, so the bell and the page never disagree). Without
    it, rows with no category that are not void or dismissed."""
    if reconcile.matching_enabled(ctx.db, ctx.store_id):
        view = "review"
        count = (
            ctx.db.query(BankTransaction.id)
               .filter(BankTransaction.store_id == ctx.store_id,
                       *reconcile.books_clause("review"))
               .count()
        )
    else:
        view = "uncategorized"
        count = (
            ctx.db.query(BankTransaction.id)
               .filter(
                   BankTransaction.store_id == ctx.store_id,
                   BankTransaction.dismissed_at.is_(None),
                   or_(BankTransaction.status.is_(None),
                       BankTransaction.status != "void"),
                   or_(BankTransaction.category_slug.is_(None),
                       BankTransaction.category_slug == ""),
               )
               .count()
        )
    if count == 0:
        return []
    return [BellItem(
        key="bank.to_check", kind="bank.to_check", urgency="due",
        count=count, view=view,
    )]


TO_CHECK = BellSource(
    kind="bank.to_check",
    # Tagging a row is an edit on the bank feed.
    permissions=("bank_sync.update",),
    feature="bank_sync",
    collect=collect_to_check,
)
