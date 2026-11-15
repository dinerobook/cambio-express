"""Check cashing item: Currency Transaction Reports to file.

Shown from five days before the earliest deadline (overdue once it has
passed), to whoever can file them. The one place outside check cashing
that reads its tables: a read-only count, approved with the CTR plan
(owner, 2026-11-15), so a deadline is never missed.
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func

from api.Modules.CheckCashing.Models import CtrReport
from api.Modules.CheckCashing.Services import module_enabled, umbrella
from api.Modules.CheckCashing.Services.ctr import DUE_SOON_DAYS
from api.Modules.Notifications.Services.bell.types import (
    BellContext, BellItem, BellSource,
)


def collect_ctr_due(ctx: BellContext) -> list[BellItem]:
    if not module_enabled(ctx.db, ctx.store_id):
        return []
    count, oldest = ctx.db.query(
        func.count(CtrReport.id), func.min(CtrReport.due_on),
    ).filter(
        CtrReport.store_id.in_(umbrella(ctx.db, ctx.store_id)),
        CtrReport.status == "to_file",
        CtrReport.due_on <= ctx.today + timedelta(days=DUE_SOON_DAYS),
    ).one()
    if not count:
        return []
    return [BellItem(
        key="check_cashing.ctr_due", kind="check_cashing.ctr_due",
        urgency="overdue" if oldest < ctx.today else "due",
        count=int(count), day=oldest,
    )]


CTR_DUE = BellSource(
    kind="check_cashing.ctr_due",
    # Filing (saving the BSA ID) is the manager's.
    permissions=("check_cashing_manage.update",),
    collect=collect_ctr_due,
)
