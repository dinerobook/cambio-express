"""PosImport — movement reports into their tables, and back out as a
read-only day summary (G-7).

Ingest is replace-by-report: a report's rows are deleted by its key
(store, family, business date, begin date + time, report periods —
``MovementHeader.key``) and written again, so a re-sent or
regenerated file never doubles anything. Nothing here touches a day
total, a P&L line or a daily-entry line: the movement data is stored
and shown, not booked.

The day summary is careful about the two traps the real files hold:

* FGM meter readings (non-resettable totals) are stated once per pump
  position and repeated on every price-tier row. They are read once
  per (grade, position), from the latest report of the day, never
  summed across tiers or reports.
* MSM mixes subtotals and their parts. Rows are returned in file
  order with a ``role``: ``subtotal`` (no modifier, and the same code /
  sub code / tender also has rows with one), ``part`` (a row such a
  subtotal adds up) or ``""``. Nothing sums the family.

Only the business-day reports (``DAY_REPORT_PERIOD``) are summarised —
a site that also sends shift reports would otherwise count each sale
twice. Every staged file is still listed.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time
from typing import Any

from sqlalchemy.orm import Session

from api.Modules.PosImport.Models import (
    PosFuelGradeMovement,
    PosItemSalesMovement,
    PosJournalFile,
    PosMerchandiseCodeMovement,
    PosMiscSummaryMovement,
    PosTaxLevelMovement,
)
from api.Modules.PosImport.Services.movement import (
    FAMILIES,
    MOVEMENT_KIND,
    MovementReport,
)

# The family's table. TPM has none: the file is accepted, nothing kept.
FAMILY_MODELS: dict[str, Any] = {
    "FGM": PosFuelGradeMovement,
    "ISM": PosItemSalesMovement,
    "MCM": PosMerchandiseCodeMovement,
    "MSM": PosMiscSummaryMovement,
    "TLM": PosTaxLevelMovement,
}

# PrimaryReportPeriod of a business-day report. Every day report in
# the sample site's export is 2; other periods are stored but left
# out of the day summary so nothing is counted twice.
DAY_REPORT_PERIOD = 2


def ingest_movement_report(
    db: Session, store_id: int, report: MovementReport, *, source_file: str,
) -> int:
    """Replace one report's rows. Returns the rows written (0 for TPM).
    The caller commits."""
    model = FAMILY_MODELS.get(report.family)
    if model is None:
        return 0
    (
        db.query(model)
        .filter_by(store_id=store_id, **report.header.key())
        .delete(synchronize_session=False)
    )
    header = report.header.columns()
    for seq, row in enumerate(report.rows, 1):
        db.add(model(
            store_id=store_id,
            source_file=source_file[:120],
            detail_seq=seq,
            **header,
            **row,
        ))
    db.flush()
    return len(report.rows)


# ── Day summary (read-only view) ───────────────────────────


@dataclass
class MovementFile:
    family: str
    filename: str
    received_at: datetime | None
    parse_error: str


@dataclass
class FuelGradeDay:
    grade_id: str
    sales_volume: float = 0.0
    sales_amount_cents: int = 0
    # Lifetime pump meters at the end of the day: one reading per
    # position, added across positions — never across tiers.
    meter_volume: float = 0.0
    meter_amount_cents: int = 0
    positions: int = 0


@dataclass
class MovementDay:
    day: date
    files: list[MovementFile] = field(default_factory=list)
    fuel: list[FuelGradeDay] = field(default_factory=list)
    departments: list[dict[str, Any]] = field(default_factory=list)
    tax_levels: list[dict[str, Any]] = field(default_factory=list)
    misc: list[dict[str, Any]] = field(default_factory=list)
    item_rows: int = 0
    item_quantity: float = 0.0
    item_amount_cents: int = 0


def _family_of(filename: str) -> str:
    """Passport names each file after its family (``FGM3402…xml``)."""
    prefix = filename[:3].upper()
    return prefix if prefix in FAMILIES.values() else ""


def day_report_rows(db: Session, model: Any, store_id: int, day: date) -> list[Any]:
    """One family's rows from the business-day reports of ``day``, in
    report then file order. Shift and other periods are left out, so
    nothing is read twice."""
    return list(
        db.query(model)
        .filter_by(
            store_id=store_id, business_date=day,
            primary_report_period=DAY_REPORT_PERIOD,
        )
        .order_by(model.begin_date, model.begin_time, model.detail_seq)
        .all()
    )


def _end_of(row: Any) -> tuple[date, time]:
    return (
        row.end_date or row.begin_date,
        row.end_time or row.begin_time,
    )


def summarise_fuel(rows: list[Any]) -> list[FuelGradeDay]:
    """Per grade: sales added over every position and tier; meter
    readings taken once per (grade, position) from the row of the
    latest report, so neither price tiers nor several reports in one
    day inflate them."""
    grades: dict[str, FuelGradeDay] = {}
    latest_meter: dict[tuple[str, str], Any] = {}
    for r in rows:
        g = grades.setdefault(r.fuel_grade_id, FuelGradeDay(r.fuel_grade_id))
        g.sales_volume += float(r.sales_volume or 0)
        g.sales_amount_cents += int(r.sales_amount_cents or 0)
        key = (r.fuel_grade_id, r.fuel_position_id)
        seen = latest_meter.get(key)
        if seen is None or _end_of(r) > _end_of(seen):
            latest_meter[key] = r
    for (grade_id, _pos), r in latest_meter.items():
        g = grades[grade_id]
        g.meter_volume += float(r.non_resettable_total_volume or 0)
        g.meter_amount_cents += int(r.non_resettable_total_amount_cents or 0)
        g.positions += 1
    for g in grades.values():
        g.sales_volume = round(g.sales_volume, 3)
        g.meter_volume = round(g.meter_volume, 3)
    return sorted(grades.values(), key=lambda g: g.grade_id)


def msm_roles(rows: list[Any]) -> list[str]:
    """``subtotal`` / ``part`` / ``""`` for each MSM row, same order.

    A group is one report's (code, sub code, tender). When it holds
    both a row without a modifier and rows with one, the former is
    the subtotal of the latter — payouts / vendorPay. Summing the
    whole group counts every payout twice."""
    def group(r: Any) -> tuple[Any, ...]:
        return (
            r.begin_date, r.begin_time, r.summary_code, r.summary_sub_code,
            r.tender_code, r.tender_sub_code,
        )

    has_plain: set[tuple[Any, ...]] = set()
    has_modified: set[tuple[Any, ...]] = set()
    for r in rows:
        (has_plain if r.summary_sub_code_modifier is None else has_modified).add(
            group(r),
        )
    split = has_plain & has_modified
    roles = []
    for r in rows:
        if group(r) not in split:
            roles.append("")
        elif r.summary_sub_code_modifier is None:
            roles.append("subtotal")
        else:
            roles.append("part")
    return roles


def movement_day(db: Session, store_id: int, day: date) -> MovementDay:
    out = MovementDay(day=day)
    files = (
        db.query(PosJournalFile)
        .filter_by(store_id=store_id, business_date=day, event_kind=MOVEMENT_KIND)
        .order_by(PosJournalFile.filename)
        .all()
    )
    out.files = [
        MovementFile(
            family=_family_of(f.filename),
            filename=f.filename,
            received_at=f.received_at,
            parse_error=f.parse_error or "",
        )
        for f in files
    ]

    out.fuel = summarise_fuel(day_report_rows(db, PosFuelGradeMovement, store_id, day))

    depts: dict[str, dict[str, Any]] = {}
    for r in day_report_rows(db, PosMerchandiseCodeMovement, store_id, day):
        d = depts.setdefault(r.merchandise_code, {
            "merchandise_code": r.merchandise_code,
            "description": r.description,
            "sales_quantity": 0.0,
            "sales_amount_cents": 0,
            "refund_amount_cents": 0,
            "transaction_count": 0,
        })
        d["description"] = r.description or d["description"]
        d["sales_quantity"] += float(r.sales_quantity or 0)
        d["sales_amount_cents"] += int(r.sales_amount_cents or 0)
        d["refund_amount_cents"] += int(r.refund_amount_cents or 0)
        d["transaction_count"] += int(r.transaction_count or 0)
    out.departments = sorted(
        depts.values(), key=lambda d: (len(d["merchandise_code"]), d["merchandise_code"]),
    )

    levels: dict[str, dict[str, Any]] = {}
    for r in day_report_rows(db, PosTaxLevelMovement, store_id, day):
        lv = levels.setdefault(r.tax_level_id, {
            "tax_level_id": r.tax_level_id,
            "taxable_sales_amount_cents": 0,
            "tax_collected_amount_cents": 0,
            "tax_exempt_sales_amount_cents": 0,
            "tax_forgiven_sales_cents": 0,
        })
        for k in (
            "taxable_sales_amount_cents", "tax_collected_amount_cents",
            "tax_exempt_sales_amount_cents", "tax_forgiven_sales_cents",
        ):
            lv[k] += int(getattr(r, k) or 0)
    out.tax_levels = sorted(levels.values(), key=lambda lv: lv["tax_level_id"])

    misc = day_report_rows(db, PosMiscSummaryMovement, store_id, day)
    out.misc = [
        {
            "summary_code": r.summary_code,
            "summary_sub_code": r.summary_sub_code,
            "summary_sub_code_modifier": r.summary_sub_code_modifier,
            "tender_code": r.tender_code,
            "tender_sub_code": r.tender_sub_code,
            "summary_amount_cents": int(r.summary_amount_cents or 0),
            "summary_count": float(r.summary_count or 0),
            "role": role,
        }
        for r, role in zip(misc, msm_roles(misc))
    ]

    items = day_report_rows(db, PosItemSalesMovement, store_id, day)
    out.item_rows = len(items)
    out.item_quantity = round(sum(float(r.sales_quantity or 0) for r in items), 3)
    out.item_amount_cents = sum(int(r.sales_amount_cents or 0) for r in items)
    return out


__all__ = [
    "DAY_REPORT_PERIOD", "FAMILY_MODELS", "FuelGradeDay", "MovementDay",
    "MovementFile", "day_report_rows", "ingest_movement_report",
    "movement_day", "msm_roles", "summarise_fuel",
]
