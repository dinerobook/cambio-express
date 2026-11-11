"""Bank item: transactions that still need a person."""
from __future__ import annotations

from api.Modules.BankSync.Models import BankTransaction
from api.Modules.BankSync.Services import reconcile
from api.Modules.Notifications.Services.bell.types import (
    BellContext, BellItem, BellSource,
)


def collect_to_check(ctx: BellContext) -> list[BellItem]:
    """The Bank page's own To reconcile count (`to_reconcile_clauses`,
    the same clause, so the bell and the page never disagree)."""
    view = (
        "review" if reconcile.matching_enabled(ctx.db, ctx.store_id)
        else "uncategorized"
    )
    count = (
        ctx.db.query(BankTransaction.id)
           .filter(BankTransaction.store_id == ctx.store_id,
                   *reconcile.to_reconcile_clauses(ctx.db, ctx.store_id))
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
