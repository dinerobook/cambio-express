"""Owner-facing return-check rollups.

Five read-side aggregates the owner dashboard + monthly P&L share:

  - `writeoff_total(...)`  : sum unrecovered balance of closed
                              checks (loss / fraud) in a window.
  - `fee_income(...)`       : the part of each payback above the
                              check's face amount (the bounce
                              fee) in a window — the only profit
                              a payback makes.
  - `period_aggregates(...)`: recoveries (cash back, by payment
                              date) + fee income + losses + fraud
                              + still-pending balance for a
                              window. Used by KPI cards.
  - `aging_buckets(db, store_ids)`: pending balance sliced into
                              0–30 / 31–60 / 61–90 / 90+ buckets.
  - `monthly_series(db, store_ids)`: 12-month recoveries vs
                              losses-plus-fraud bars.
  - `monthly_pl(db, store_id, year, month)`: signed value for the
                              monthly P&L's Return Check (G/L)
                              line. Sign-flipped relative to
                              `period_aggregates['net_gl']` so
                              loss-positive (expense convention).

The gain/loss rule (Monthly INVARIANTS.md, "Returned check
gain/loss"): a bounced check is money the store is owed, not a loss
yet, so paying back its face amount returns the store's own money
and is NOT profit. The P&L moves only on:

  - fee income — the part of a payback above the face amount (the
    returned-check fee), measured at the PAYMENT level so a fee paid
    in May lands on May;
  - write-offs — losses/fraud at the parent level on
    `status_changed_on` (single closing event), summed against the
    REMAINING face amount (parent.amount − payments already
    received).

Cash recovered (`recoveries`) is still reported, as a cash figure
for the owner dashboard, never as profit.
"""
from calendar import monthrange
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session
from typing import Any

from api.Core.Clock import store_local_today


def _models():
    """Lazy-import the ORM models so this module can be imported
    before app.py finishes wiring up the model registry."""
    from api.Modules.ReturnChecks.Models import ReturnCheck, ReturnCheckPayment
    return ReturnCheck, ReturnCheckPayment


def writeoff_total(
    db: Session,
    store_ids: list[int],
    start: date,
    end: date,
    status_value: str,
) -> float:
    """Sum the still-owed balance of return checks marked
    `status_value` (typically 'loss' or 'fraud') whose
    `status_changed_on` falls in `[start, end]`.

    Subtracts payments already received against each parent —
    partial recoveries before the close were already booked as
    recoveries in their own months.
    """
    if not store_ids:
        return 0.0
    ReturnCheck, ReturnCheckPayment = _models()
    rows = (
        db.query(ReturnCheck.id, ReturnCheck.amount_cents / 100.0)
          .filter(
              ReturnCheck.store_id.in_(store_ids),
              ReturnCheck.status == status_value,
              ReturnCheck.status_changed_on >= start,
              ReturnCheck.status_changed_on <= end,
          )
          .all()
    )
    if not rows:
        return 0.0
    rc_ids = [rid for rid, _ in rows]
    # Sum payments per parent in one query — avoids N+1.
    paid_rows = (
        db.query(
            ReturnCheckPayment.return_check_id,
            func.coalesce(func.sum(ReturnCheckPayment.amount_cents), 0) / 100.0,
        )
        .filter(ReturnCheckPayment.return_check_id.in_(rc_ids))
        .group_by(ReturnCheckPayment.return_check_id)
        .all()
    )
    paid_by = {rid: float(s or 0.0) for rid, s in paid_rows}
    total = 0.0
    for rid, amt in rows:
        total += max(0.0, float(amt or 0.0) - paid_by.get(rid, 0.0))
    return total


def fee_income(
    db: Session, store_ids: list[int], start: date, end: date,
) -> float:
    """Fee dollars collected in ``[start, end]``: for every payback
    in the window, the part that lands above its check's face
    amount once the check's earlier paybacks are counted (a payback
    pays the face amount first, then the fee). Paying back the face
    amount is the store getting its own money back — not profit.
    """
    if not store_ids:
        return 0.0
    ReturnCheck, ReturnCheckPayment = _models()
    # Checks with a payback in the window; every payback of those
    # checks is needed, earlier ones too, to know where the face
    # amount ran out.
    in_window = (
        select(ReturnCheckPayment.return_check_id)
          .join(ReturnCheck, ReturnCheckPayment.return_check_id == ReturnCheck.id)
          .where(
              ReturnCheck.store_id.in_(store_ids),
              ReturnCheckPayment.paid_on >= start,
              ReturnCheckPayment.paid_on <= end,
          )
    )
    rows = (
        db.query(
            ReturnCheckPayment.return_check_id,
            ReturnCheck.amount_cents,
            ReturnCheckPayment.amount_cents,
            ReturnCheckPayment.paid_on,
        )
        .join(ReturnCheck, ReturnCheckPayment.return_check_id == ReturnCheck.id)
        .filter(ReturnCheckPayment.return_check_id.in_(in_window))
        .order_by(
            ReturnCheckPayment.return_check_id,
            ReturnCheckPayment.paid_on,
            ReturnCheckPayment.id,
        )
        .all()
    )
    fee_cents = 0
    paid_so_far: dict[int, int] = {}
    for rc_id, face, paid, paid_on in rows:
        before = paid_so_far.get(rc_id, 0)
        after = before + int(paid or 0)
        paid_so_far[rc_id] = after
        if start <= paid_on <= end:
            face = int(face or 0)
            fee_cents += max(0, after - face) - max(0, before - face)
    return fee_cents / 100.0


def period_aggregates(
    db: Session, store_ids: list[int], start: date, end: date,
) -> dict[str, Any]:
    """Sum recoveries (cash back, by payment date), fee income and
    losses+fraud (by parent status-change date), plus the
    still-pending balance.

    `net_gl` is gain-positive — fee income minus write-offs, never
    the cash recovered (see the module docstring); `monthly_pl`
    flips the sign for the P&L expense column.

    Empty `store_ids` returns all-zero dict — caller doesn't need
    to short-circuit.
    """
    if not store_ids:
        return {
            "recoveries": 0.0, "fee_income": 0.0, "losses": 0.0,
            "fraud": 0.0, "net_gl": 0.0, "pending": 0.0, "pending_count": 0,
        }
    ReturnCheck, ReturnCheckPayment = _models()

    # Recoveries: Σ payments by paid_on, joined to parent for the
    # store filter. Payment doesn't carry store_id — parent does
    # — so we join through.
    rec = (
        db.query(func.coalesce(func.sum(ReturnCheckPayment.amount_cents), 0) / 100.0)
          .join(
              ReturnCheck,
              ReturnCheckPayment.return_check_id == ReturnCheck.id,
          )
          .filter(
              ReturnCheck.store_id.in_(store_ids),
              ReturnCheckPayment.paid_on >= start,
              ReturnCheckPayment.paid_on <= end,
          )
          .scalar() or 0.0
    )

    fees = fee_income(db, store_ids, start, end)
    loss = writeoff_total(db, store_ids, start, end, "loss")
    fraud = writeoff_total(db, store_ids, start, end, "fraud")

    pending_q = (
        db.query(
            func.coalesce(func.sum(ReturnCheck.amount_cents), 0) / 100.0,
            func.count(ReturnCheck.id),
        )
        .filter(
            ReturnCheck.store_id.in_(store_ids),
            ReturnCheck.status == "pending",
            ReturnCheck.bounced_on <= end,
        )
        .first()
    )
    pending_amount_total = float(pending_q[0] or 0.0)
    pending_count = int(pending_q[1] or 0)
    # Subtract installments already received against pending
    # parents so the "Pending balance" KPI shows OUTSTANDING owed,
    # not original face value.
    if pending_count > 0:
        pending_paid = (
            db.query(func.coalesce(func.sum(ReturnCheckPayment.amount_cents), 0) / 100.0)
              .join(
                  ReturnCheck,
                  ReturnCheckPayment.return_check_id == ReturnCheck.id,
              )
              .filter(
                  ReturnCheck.store_id.in_(store_ids),
                  ReturnCheck.status == "pending",
                  ReturnCheck.bounced_on <= end,
              )
              .scalar() or 0.0
        )
        pending = max(0.0, pending_amount_total - float(pending_paid))
    else:
        pending = 0.0

    return {
        "recoveries":   float(rec),
        "fee_income":   fees,
        "losses":       float(loss),
        "fraud":        float(fraud),
        "net_gl":       round(fees - float(loss) - float(fraud), 2),
        "pending":      pending,
        "pending_count": pending_count,
    }


def aging_buckets(
    db: Session, store_ids: list[int], today: date | None = None,
) -> list[dict[str, Any]]:
    """Pending balance sliced into 0–30 / 31–60 / 61–90 / 90+
    buckets by `bounced_on`. Helps the owner spot stale
    receivables that probably won't recover. ``today`` defaults to
    the first store's calendar day (``store_local_today``)."""
    if today is None:
        today = store_local_today(db, store_ids[0] if store_ids else None)
    if not store_ids:
        return [
            {"label": "0–30 d",  "amount": 0.0, "count": 0},
            {"label": "31–60 d", "amount": 0.0, "count": 0},
            {"label": "61–90 d", "amount": 0.0, "count": 0},
            {"label": "90+ d",   "amount": 0.0, "count": 0},
        ]
    ReturnCheck, _ = _models()
    rows = (
        db.query(ReturnCheck)
          .filter(
              ReturnCheck.store_id.in_(store_ids),
              ReturnCheck.status == "pending",
          )
          .all()
    )
    buckets = [
        {"label": "0–30 d",  "amount": 0.0, "count": 0, "max": 30},
        {"label": "31–60 d", "amount": 0.0, "count": 0, "max": 60},
        {"label": "61–90 d", "amount": 0.0, "count": 0, "max": 90},
        {"label": "90+ d",   "amount": 0.0, "count": 0, "max": None},
    ]
    for r in rows:
        age = (today - r.bounced_on).days if r.bounced_on else 0
        for b in buckets:
            if b["max"] is None or age <= b["max"]:
                b["amount"] += float(r.amount or 0.0)
                b["count"]  += 1
                break
    for b in buckets:
        b.pop("max", None)
    return buckets


def monthly_series(
    db: Session, store_ids: list[int], today: date | None = None,
) -> tuple[list[str], list[float], list[float]]:
    """12-month bars for the owner dashboard: per-month recoveries
    (positive) and losses+fraud (negative). Labels are 'YYYY-MM'
    so ApexCharts renders them as a date axis. ``today`` defaults to
    the first store's calendar day (``store_local_today``)."""
    if today is None:
        today = store_local_today(db, store_ids[0] if store_ids else None)
    months = []
    y, m = today.year, today.month
    for _ in range(12):
        months.append((y, m))
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    months.reverse()  # oldest → newest
    labels: list[str] = []
    recoveries: list[float] = []
    losses: list[float] = []
    if not store_ids:
        for (yy, mm) in months:
            labels.append(f"{yy:04d}-{mm:02d}")
            recoveries.append(0.0)
            losses.append(0.0)
        return labels, recoveries, losses
    for (yy, mm) in months:
        s = date(yy, mm, 1)
        e = date(yy, mm, monthrange(yy, mm)[1])
        agg = period_aggregates(db, store_ids, s, e)
        labels.append(f"{yy:04d}-{mm:02d}")
        recoveries.append(round(agg["recoveries"], 2))
        # Combine loss + fraud — both are write-offs from the P&L's POV.
        losses.append(round(agg["losses"] + agg["fraud"], 2))
    return labels, recoveries, losses


def monthly_pl(
    db: Session, store_id: int, year: int, month: int,
) -> float:
    """Signed value for the monthly P&L's Return Check (G/L) line,
    using EXPENSE convention so it slots correctly into the
    expense column on monthly_report (which subtracts from net
    income).

      positive  → net loss for the month (write-offs > fees collected)
      negative  → net gain for the month (fees collected > write-offs)

    Paying back a check's face amount is NOT a gain (module
    docstring).

    Note: `period_aggregates['net_gl']` uses the OPPOSITE
    convention (positive = gain) because that's what the owner
    dashboard shows. We deliberately negate here so each consumer
    reads the right sign for its context.
    """
    start = date(year, month, 1)
    end = date(year, month, monthrange(year, month)[1])
    agg = period_aggregates(db, [store_id], start, end)
    return -agg["net_gl"]
