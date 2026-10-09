"""Per-company Money Transfer breakdown for the daily-book editor.

Phase 3 of the daily-book redesign. The legacy Jinja MT table let
cashiers enter per-company amount/fees/federal_tax/commission for
each daily report; values persisted to `MoneyTransferSummary` and
the grand total mirrored into `DailyReport.money_transfer` so the
receipts tab stayed in sync.

This module wraps two flows:

  • `read_mt_breakdown(db, store_id, date)` — returns one row per
    company configured for the store. Each row carries both the
    saved values (`MoneyTransferSummary`, if any) AND the auto-fill
    defaults (from `summarize_transfers_for_day`). The React editor
    uses saved-when-present, auto-otherwise — so a fresh day pre-
    fills from the employee transfer log and overridden days keep
    the operator's edits.

  • `replace_mt_breakdown(db, store_id, date, rows)` — bulk-replace
    semantics: every `MoneyTransferSummary` row for (store, date) is
    deleted + recreated from `rows`. The `DailyReport.money_transfer`
    field is updated to the grand sum so the daily P&L stays
    consistent in one transaction. Caller commits.

Services (bill payments, top-ups, recharges) ride the same two flows:
`MTBreakdown.services` carries the saved `MoneyServiceSummary` rows,
and `replace_mt_breakdown(..., services=[...])` replaces them in the
same transaction. The day's mirrored `money_transfer` is the grand
total of transfers AND services — the In column's "Services" box.
`services=None` (a caller that only knows transfers, e.g. the
Intermex import) leaves the day's services untouched and still
counts them in the total.

Locked-day guard: writes are refused when the daily report's lock
is set — matches the contract on
`update_daily_report` (DailyReportLockedError → HTTP 403).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from sqlalchemy.orm import Session

from api.Modules.DailyBook.Services.reports import (
    DailyReportLockedError,
    ensure_daily_report,
)
from api.Modules.DailyBook.Services.transfers_summary import (
    summarize_transfers_for_day,
)
from api.Core.Clock import utc_now


@dataclass
class MTRow:
    """One company's saved + auto values for the breakdown table.

    `saved_*` carries what the operator last typed (zeros if the
    company has no MoneyTransferSummary row yet); `auto_*` carries
    the aggregate from the employee transfer log so the React
    editor can show a "reset to auto" affordance and flag
    overridden cells visually."""
    company: str
    saved_amount: float
    saved_fees: float
    saved_federal_tax: float
    saved_commission: float
    auto_amount: float
    auto_fees: float
    auto_federal_tax: float
    auto_commission: float
    auto_count: int

    @property
    def saved_total(self) -> float:
        return (
            float(self.saved_amount or 0)
            + float(self.saved_fees or 0)
            + float(self.saved_federal_tax or 0)
            + float(self.saved_commission or 0)
        )

    @property
    def auto_total(self) -> float:
        return (
            float(self.auto_amount or 0)
            + float(self.auto_fees or 0)
            + float(self.auto_federal_tax or 0)
            + float(self.auto_commission or 0)
        )


# Services a transfer provider handles besides transfers. key → label.
# The key is what `msb_mt_service.service` stores; the order is the
# order of the tabs in the Services box.
SERVICE_KINDS: dict[str, str] = {
    "bill_payment": "Bill payments",
    "top_up":       "Top-ups",
    "recharge":     "Recharges",
}


@dataclass
class ServiceRow:
    """One company's saved amount + fee for one service on one day.
    Used for both the read payload and the write payload."""
    company: str
    service: str
    amount: float
    fees: float

    @property
    def total(self) -> float:
        return float(self.amount or 0) + float(self.fees or 0)


@dataclass
class MTBreakdown:
    """Full per-day breakdown — transfer rows, saved service rows, and
    grand-total properties for both saved and auto views."""
    rows: list[MTRow]
    services: list[ServiceRow] = field(default_factory=list)

    @property
    def saved_total(self) -> float:
        return (sum(r.saved_total for r in self.rows)
                + sum(s.total for s in self.services))

    @property
    def auto_total(self) -> float:
        return sum(r.auto_total for r in self.rows)


def read_mt_breakdown(
    db: Session, store_id: int, report_date: date,
) -> MTBreakdown:
    """Per-company breakdown for one (store, date). One row per
    active company in the store config, plus any "unknown"
    companies that have either a saved row OR transfers logged
    against them under that name (carry-over from a deleted
    company entry). Unknowns sort alphabetically after the
    configured list."""
    from api.Modules.DailyBook.Models import MoneyTransferSummary

    auto_summary = summarize_transfers_for_day(db, store_id, report_date)
    auto_by_co = {row.company: row for row in auto_summary.by_company}

    saved_rows = (
        db.query(MoneyTransferSummary)
          .filter_by(store_id=int(store_id), report_date=report_date)
          .all()
    )
    saved_by_co = {r.company: r for r in saved_rows}

    # Union of configured companies + every company we have data
    # for (saved or auto). Preserve configured order; trailing
    # extras alphabetical.
    configured = list(auto_summary.companies)
    # Coerce dict keys to ``str`` — ``saved_by_co`` may be keyed
    # off Column[str] values; mypy can't see SQLAlchemy's runtime
    # equality semantics, but ``str(col)`` round-trips cleanly.
    services = _read_services(db, store_id, report_date)
    saved_keys: set[str] = {str(k) for k in saved_by_co.keys()}
    saved_keys |= {s.company for s in services}
    auto_keys:  set[str] = {str(k) for k in auto_by_co.keys()}
    extras = sorted(
        {c for c in (saved_keys | auto_keys) if c not in configured},
        key=str.lower,
    )
    company_order = configured + extras

    rows: list[MTRow] = []
    for co in company_order:
        saved = saved_by_co.get(co)  # type: ignore[call-overload]
        auto = auto_by_co.get(co)
        rows.append(MTRow(
            company=co,
            saved_amount=float(saved.amount or 0) if saved else 0.0,
            saved_fees=float(saved.fees or 0) if saved else 0.0,
            saved_federal_tax=float(saved.federal_tax or 0) if saved else 0.0,
            saved_commission=float(saved.commission or 0) if saved else 0.0,
            auto_amount=float(auto.amount) if auto else 0.0,
            auto_fees=float(auto.fees) if auto else 0.0,
            auto_federal_tax=float(auto.federal_tax) if auto else 0.0,
            auto_commission=float(auto.commission) if auto else 0.0,
            auto_count=int(auto.count) if auto else 0,
        ))
    return MTBreakdown(rows=rows, services=services)


def _read_services(
    db: Session, store_id: int, report_date: date,
) -> list[ServiceRow]:
    from api.Modules.DailyBook.Models import MoneyServiceSummary

    order = list(SERVICE_KINDS)
    saved = (
        db.query(MoneyServiceSummary)
          .filter_by(store_id=int(store_id), report_date=report_date)
          .all()
    )
    rows = [
        ServiceRow(company=str(r.company), service=str(r.service),
                   amount=float(r.amount or 0), fees=float(r.fees or 0))
        for r in saved
    ]
    rows.sort(key=lambda r: (
        order.index(r.service) if r.service in order else len(order),
        r.company.lower(),
    ))
    return rows


@dataclass
class MTWriteRow:
    """Caller's per-company write payload. Pydantic schema mirrors
    this shape 1:1 — keep them in sync if you add a column to
    MoneyTransferSummary."""
    company: str
    amount: float
    fees: float
    federal_tax: float
    commission: float


class UnknownServiceError(ValueError):
    """A service key outside SERVICE_KINDS. The request schema already
    refuses these (422); this guards direct Service callers."""


def replace_mt_breakdown(
    db: Session, *, store_id: int, report_date: date,
    rows: list[MTWriteRow],
    services: list[ServiceRow] | None = None,
) -> float:
    """Bulk-replace the per-company breakdown for (store, date).

    Returns the new grand total (which has also been written into
    `DailyReport.money_transfer` so the receipts tab stays in
    sync). Caller commits.

    Locked-day guard mirrors `update_daily_report`: a write to a
    locked report raises `DailyReportLockedError` — the route
    surface translates that to HTTP 403.

    Empty `rows` is valid (clears every saved row for the day +
    sets `money_transfer` to 0).
    """
    from api.Modules.DailyBook.Models import (
        MoneyServiceSummary, MoneyTransferSummary,
    )

    for svc in services or []:
        if svc.service not in SERVICE_KINDS:
            raise UnknownServiceError(f"Unknown service: {svc.service!r}")

    report = ensure_daily_report(db, store_id, report_date)
    if report.locked_at is not None:
        raise DailyReportLockedError(
            "Daily report is locked — unlock it before editing.",
        )

    # Bulk-replace: drop every existing row for the day, then
    # insert the new ones. Cheaper + simpler than a per-row upsert
    # given each store has ≤10 companies in practice.
    (
        db.query(MoneyTransferSummary)
          .filter_by(store_id=int(store_id), report_date=report_date)
          .delete(synchronize_session=False)
    )

    grand_total = 0.0
    for row in rows:
        co = (row.company or "").strip()
        if not co:
            continue
        amt = float(row.amount or 0)
        fees = float(row.fees or 0)
        tax = float(row.federal_tax or 0)
        comm = float(row.commission or 0)
        row_total = amt + fees + tax + comm
        # Skip pure-zero rows so we don't bloat the table for
        # companies the cashier left untouched. The read-side
        # falls back to the auto values when no saved row exists.
        if row_total == 0:
            continue
        db.add(MoneyTransferSummary(
            store_id=int(store_id), report_date=report_date,
            company=co, amount=amt, fees=fees,
            federal_tax=tax, commission=comm,
        ))
        grand_total += row_total

    if services is not None:
        (
            db.query(MoneyServiceSummary)
              .filter_by(store_id=int(store_id), report_date=report_date)
              .delete(synchronize_session=False)
        )
        merged: dict[tuple[str, str], tuple[float, float]] = {}
        for svc in services:
            co = (svc.company or "").strip()
            amt, fees = float(svc.amount or 0), float(svc.fees or 0)
            if not co or (amt == 0 and fees == 0):
                continue
            prev = merged.get((co, svc.service), (0.0, 0.0))
            merged[(co, svc.service)] = (prev[0] + amt, prev[1] + fees)
        for (co, kind), (amt, fees) in merged.items():
            db.add(MoneyServiceSummary(
                store_id=int(store_id), report_date=report_date,
                company=co, service=kind, amount=amt, fees=fees,
            ))
    db.flush()
    # Services count in the day's total whether or not this call
    # replaced them — a transfers-only caller must not drop them.
    grand_total += sum(
        s.total for s in _read_services(db, store_id, report_date)
    )

    # Mirror the grand total into the daily report so the receipts
    # tab + total_receipts both pick it up. Keep the existing
    # value if the caller passed zero rows — that way "clear the
    # breakdown" doesn't accidentally wipe a manually-typed
    # money_transfer field.
    if rows or services is not None:
        report.money_transfer = float(grand_total)
        # money_transfer feeds total_receipts, so the derived
        # over_short reconciliation has to be refreshed with it.
        report.over_short = report.computed_over_short
        report.updated_at = utc_now()
    db.flush()
    return float(grand_total)
