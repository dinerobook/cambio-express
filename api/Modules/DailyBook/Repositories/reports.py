"""DailyReport SQL helpers.

DailyReport is keyed `(store_id, report_date)` — one row per
store per day. Lookup is almost always by either the unique
`(store, date)` pair or by `id` after a write.
"""
from datetime import date
from typing import Iterable, Iterator

from sqlalchemy.orm import Session

from api.Modules.DailyBook.Models import DailyReport


def find_report_by_date(
    db: Session, store_id: int, report_date: date,
) -> DailyReport | None:
    """Lookup by `(store_id, report_date)` — the unique constraint
    guarantees at most one match. Returns `None` for stores that
    haven't logged a report on this date yet."""
    return (
        db.query(DailyReport)
          .filter(
              DailyReport.store_id == store_id,
              DailyReport.report_date == report_date,
          )
          .first()
    )


def iter_reports_before(
    db: Session, store_id: int, before_date: date, *, batch: int = 32,
) -> Iterator[DailyReport]:
    """This store's DailyReport rows strictly before ``before_date``,
    newest first, fetched a batch at a time. Powers the
    forward-balance carry, which walks back to the previous day the
    operator actually kept (``Services/reports.py::find_kept_prior``)
    — almost always the first row, so one small query."""
    offset = 0
    while True:
        rows = (
            db.query(DailyReport)
              .filter(
                  DailyReport.store_id == store_id,
                  DailyReport.report_date < before_date,
              )
              .order_by(DailyReport.report_date.desc())
              .offset(offset)
              .limit(batch)
              .all()
        )
        yield from rows
        if len(rows) < batch:
            return
        offset += batch


def iter_reports_after(
    db: Session, store_id: int, after_date: date, *, batch: int = 8,
) -> Iterator[DailyReport]:
    """This store's DailyReport rows strictly after ``after_date``,
    oldest first, a batch at a time — the days whose carry a change
    on ``after_date`` can move (``refresh_carry``)."""
    offset = 0
    while True:
        rows = (
            db.query(DailyReport)
              .filter(
                  DailyReport.store_id == store_id,
                  DailyReport.report_date > after_date,
              )
              .order_by(DailyReport.report_date.asc())
              .offset(offset)
              .limit(batch)
              .all()
        )
        yield from rows
        if len(rows) < batch:
            return
        offset += batch


def get_report_by_id(
    db: Session, report_id: int, store_ids: Iterable[int],
) -> DailyReport | None:
    """Scoped get-by-id. Returns `None` for cross-tenant lookups so
    callers translate to 404."""
    return (
        db.query(DailyReport)
          .filter(
              DailyReport.id == report_id,
              DailyReport.store_id.in_(store_ids),
          )
          .first()
    )


def list_reports_in_period(
    db: Session, store_ids: Iterable[int],
    d_from: date, d_to: date,
) -> list[DailyReport]:
    """All DailyReport rows for the given stores between d_from and
    d_to (inclusive), ordered by `report_date asc, id asc`. Used by
    the monthly P&L roll-up + the owner-umbrella summary."""
    return (
        db.query(DailyReport)
          .filter(
              DailyReport.store_id.in_(store_ids),
              DailyReport.report_date >= d_from,
              DailyReport.report_date <= d_to,
          )
          .order_by(
              DailyReport.report_date.asc(),
              DailyReport.id.asc(),
          )
          .all()
    )
