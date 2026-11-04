"""Returned checks item: checks still pending after a month."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func

from api.Modules.Notifications.Services.bell.types import (
    BellContext, BellItem, BellSource,
)
from api.Modules.ReturnChecks.Models import ReturnCheck

# A returned check still pending this many days after it bounced
# shows in the bell. Owner default, 2026-11-04.
PENDING_AFTER_DAYS = 30


def collect_pending(ctx: BellContext) -> list[BellItem]:
    cutoff = ctx.today - timedelta(days=PENDING_AFTER_DAYS)
    count, total, oldest = ctx.db.query(
        func.count(ReturnCheck.id),
        func.coalesce(func.sum(ReturnCheck.amount_cents), 0),
        func.min(ReturnCheck.bounced_on),
    ).filter(
        ReturnCheck.store_id == ctx.store_id,
        ReturnCheck.status == "pending",
        ReturnCheck.bounced_on <= cutoff,
    ).one()
    if not count:
        return []
    return [BellItem(
        key="return_checks.pending", kind="return_checks.pending",
        urgency="overdue", count=int(count), day=oldest,
        amount_cents=int(total),
    )]


PENDING = BellSource(
    kind="return_checks.pending",
    # Recording a payment or a write-off is an edit.
    permissions=("return_checks.update",),
    module="module_check_cashing",
    collect=collect_pending,
)
