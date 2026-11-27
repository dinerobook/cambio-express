"""The P&L for any date range (owner, 2026-11-27: the Period P&L
merged into the Monthly P&L page) — Monthly INVARIANTS "Any date
range".

A range is cut into the months it touches:

* a month wholly inside it counts exactly as its own page reads it
  (`summarize_monthly`, every line, typed ones included);
* a month cut by the range counts only what has a day — the
  Transactions ledger's counted rows dated inside the range
  (`build_ledger`: daily books, bank rows by booking day, moved
  entries), plus the returned-check activity and money order charges
  of those days. A typed line has no day, so it is left out and
  reported in `left_out`, the way the page says so.

Pure read.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

MAX_DAYS = 1100  # about three years: the whole months are cheap, the cut ones are two


@dataclass
class LeftOut:
    line: str
    amount: float
    year: int
    month: int


@dataclass
class RangeSummary:
    d_from: date
    d_to: date
    lines: dict[str, float] = field(default_factory=dict)
    # slug → [CustomLine-like dict: id, slug, name, section, amount]
    custom: dict[str, dict[str, Any]] = field(default_factory=dict)
    bank_locked: set[str] = field(default_factory=set)
    daily_fed: set[str] = field(default_factory=set)
    days_entered: int = 0
    money_order_count: int = 0
    money_order_charges: float = 0.0
    whole_months: int = 0
    left_out: list[LeftOut] = field(default_factory=list)
    total_income: float = 0.0
    total_expenses: float = 0.0

    @property
    def net_profit(self) -> float:
        return round(self.total_income - self.total_expenses, 2)

    def add(self, line: str, amount: float) -> None:
        self.lines[line] = round(self.lines.get(line, 0.0) + amount, 2)


def _months(d_from: date, d_to: date) -> list[tuple[int, int]]:
    out = []
    y, m = d_from.year, d_from.month
    while (y, m) <= (d_to.year, d_to.month):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def range_summary(
    db: Session, store_id: int, d_from: date, d_to: date,
) -> RangeSummary:
    from api.Modules.Monthly.Services.daily_feed import (
        _entered_days, _money_order_charges, month_bounds,
    )
    from api.Modules.Monthly.Services.monthly import (
        EXPENSE_FIELDS, INCOME_FIELDS, summarize_monthly,
    )

    out = RangeSummary(d_from=d_from, d_to=d_to)
    custom_names: dict[str, Any] = {}
    for y, m in _months(d_from, d_to):
        start, end = month_bounds(y, m)
        s = summarize_monthly(db, store_id, y, m)
        if s is None:
            continue
        if d_from <= start and end <= d_to:
            out.whole_months += 1
            for f in (*INCOME_FIELDS, *EXPENSE_FIELDS):
                v = s.value(f)
                if v:
                    out.add(f, v)
            for c in s.custom:
                _add_custom(out, c.slug, c.id, c.name, c.section, c.amount)
            out.bank_locked |= set(s.bank_fed)
            out.daily_fed |= set(s.daily_fed)
            out.days_entered += s.daily.days
            out.money_order_count += s.daily.money_order_count
            out.money_order_charges = round(
                out.money_order_charges + s.daily.money_order_charges, 2,
            )
            continue
        a, b = max(start, d_from), min(end, d_to)
        _cut_month(db, store_id, y, m, a, b, s, out, custom_names)
        out.days_entered += _entered_days(db, store_id, a, b)
        count, charges = _money_order_charges(db, store_id, a, b)
        if charges:
            out.add("money_order_fees", -charges)
            out.daily_fed.add("money_order_fees")
        out.money_order_count += count
        out.money_order_charges = round(out.money_order_charges + charges, 2)
        rc = _return_check_gl(db, store_id, a, b)
        if rc:
            out.add("return_check_gl", rc)
    out.total_income = round(
        sum(out.lines.get(f, 0.0) for f in INCOME_FIELDS)
        + sum(c["amount"] for c in out.custom.values() if c["section"] == "income"), 2,
    )
    out.total_expenses = round(
        sum(out.lines.get(f, 0.0) for f in EXPENSE_FIELDS)
        + sum(c["amount"] for c in out.custom.values() if c["section"] == "expense"), 2,
    )
    return out


def _add_custom(
    out: RangeSummary, slug: str, cid: int, name: str, section: str, amount: float,
) -> None:
    c = out.custom.setdefault(slug, {
        "id": cid, "slug": slug, "name": name, "section": section, "amount": 0.0,
    })
    c["amount"] = round(c["amount"] + amount, 2)


def _cut_month(
    db: Session, store_id: int, y: int, m: int, a: date, b: date,
    s: Any, out: RangeSummary, custom_names: dict[str, Any],
) -> None:
    """The counted ledger rows of one month dated a..b."""
    from api.Modules.Monthly.Services import custom_categories
    from api.Modules.Monthly.Services.ledger import build_ledger

    if not custom_names:
        custom_names.update({
            c.slug: c for c in custom_categories.store_categories(db, store_id)
        })
    for r in build_ledger(db, store_id, y, m, s):
        if not r.counted or r.line is None:
            continue
        if r.source in ("money_order_charges", "returned_checks"):
            continue  # worked out for the days themselves (caller)
        if r.day is None:
            out.left_out.append(LeftOut(r.line, round(r.amount, 2), y, m))
            continue
        if not (a <= r.day <= b):
            continue
        if r.line.startswith(custom_categories.PREFIX):
            c = custom_names.get(r.line)
            if c is not None:
                _add_custom(out, r.line, int(c.id), str(c.name), str(c.section), r.amount)
            continue
        out.add(r.line, r.amount)
        if r.source == "bank":
            out.bank_locked.add(r.line)
        else:
            out.daily_fed.add(r.line)


def _return_check_gl(db: Session, store_id: int, a: date, b: date) -> float:
    """The returned-check line for some days (expense convention, the
    same rule as the month's)."""
    from api.Modules.Owners.Services.return_checks import period_aggregates

    return round(-float(period_aggregates(db, [store_id], a, b)["net_gl"] or 0), 2)
