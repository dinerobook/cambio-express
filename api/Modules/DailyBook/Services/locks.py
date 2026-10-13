"""Daily-report lock predicate.

`is_locked(db, store_id, report_date)` returns True when a
`DailyReport` row exists for the given store + date and has
`locked_at` set. Write routes in the daily-book flow call this
first and bail before touching the DB.

Pure read — no DB writes, no commits.
"""
from datetime import date
from typing import Iterable

from sqlalchemy.orm import Session


def is_locked(
    db: Session, store_id: int, report_date: date,
) -> bool:
    """True iff the DailyReport for (store, date) exists and has
    `locked_at` set.

    Returns False both when the row doesn't exist (nothing to
    lock yet) and when it exists but is unlocked.
    """
    from api.Modules.DailyBook.Models import DailyReport
    rpt = (
        db.query(DailyReport)
          .filter_by(store_id=store_id, report_date=report_date)
          .first()
    )
    return bool(rpt and rpt.locked_at)


def locked_dates(
    db: Session, store_id: int, report_dates: Iterable[date],
) -> set[date]:
    """The subset of ``report_dates`` whose DailyReport is locked —
    one query for a list of entries spread across days (the open
    settlements list)."""
    from api.Modules.DailyBook.Models import DailyReport
    wanted = set(report_dates)
    if not wanted:
        return set()
    rows = (
        db.query(DailyReport.report_date)
          .filter(
              DailyReport.store_id == store_id,
              DailyReport.report_date.in_(wanted),
              DailyReport.locked_at.isnot(None),
          )
          .all()
    )
    return {r[0] for r in rows}
