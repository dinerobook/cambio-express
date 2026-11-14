"""Who returns checks: the store's returned checks grouped by company
or by customer (``party_key``), with how often and how much.

Worked out live from the checks — nothing is stored — so a fixed typo
or a newly entered check shows up at once. A store has hundreds of
returned checks, not millions, so grouping happens in Python over one
query.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy.orm import Session, selectinload

from api.Modules.ReturnChecks.Models import ReturnCheck
from api.Modules.ReturnChecks.parties import party_key

TRACK_BY = ("company", "customer")

# Sort slugs for the tracking lists; anything else = most checks first.
TRACK_SORTS = ("checks", "amount", "owed", "last", "name", "lost")


@dataclass
class PartyTotal:
    key: str
    name: str            # the spelling on the most recent check
    check_count: int
    amount_cents: int    # face amount of every check
    owed_cents: int      # still owed on open (pending) checks, fee included
    open_count: int
    lost_count: int      # written off: loss or fraud
    lost_cents: int      # unpaid face amount of those
    last_returned_on: date | None
    routing_number: str  # latest one typed for a company; "" for customers


def party_totals(
    db: Session, store_id: int, *, by: str, q: str = "",
    date_from: date | None = None, date_to: date | None = None,
    sort: str = "", direction: str = "desc",
) -> list[PartyTotal]:
    """One row per company (``by="company"``) or customer, for checks
    returned between ``date_from`` and ``date_to`` (either may be
    open). ``q`` keeps names whose key contains the search's key."""
    query = (
        db.query(ReturnCheck)
          .options(selectinload(ReturnCheck.payments))
          .filter(ReturnCheck.store_id == store_id)
    )
    if date_from is not None:
        query = query.filter(ReturnCheck.bounced_on >= date_from)
    if date_to is not None:
        query = query.filter(ReturnCheck.bounced_on <= date_to)
    checks = query.order_by(ReturnCheck.bounced_on.asc(), ReturnCheck.id.asc()).all()

    needle = party_key(q)
    groups: dict[str, PartyTotal] = {}
    for c in checks:
        raw = c.company_name if by == "company" else c.customer_name
        key = party_key(raw)
        if not key or (needle and needle not in key):
            continue
        row = groups.get(key)
        if row is None:
            row = groups[key] = PartyTotal(
                key=key, name="", check_count=0, amount_cents=0, owed_cents=0,
                open_count=0, lost_count=0, lost_cents=0,
                last_returned_on=None, routing_number="",
            )
        # Checks come oldest first, so the last one seen sets the
        # display spelling, the latest date and the routing number.
        row.name = (raw or "").strip()
        row.check_count += 1
        row.amount_cents += int(c.amount_cents or 0)
        row.last_returned_on = c.bounced_on
        if c.status == "pending":
            row.open_count += 1
            row.owed_cents += c.remaining_cents
        elif c.status in ("loss", "fraud"):
            row.lost_count += 1
            row.lost_cents += max(
                0, int(c.amount_cents or 0) - c.recovered_total_cents,
            )
        if by == "company" and c.routing_number:
            row.routing_number = c.routing_number

    rows = list(groups.values())
    reverse = direction != "asc"
    keyfuncs = {
        "amount": lambda r: (r.amount_cents, r.check_count),
        "owed": lambda r: (r.owed_cents, r.check_count),
        "lost": lambda r: (r.lost_cents, r.lost_count),
        "last": lambda r: (r.last_returned_on or date.min, r.check_count),
        "name": lambda r: (r.key,),
    }
    keyfunc = keyfuncs.get(sort, lambda r: (r.check_count, r.amount_cents))
    # Stable tiebreak: name A→Z, whatever the main direction.
    rows.sort(key=lambda r: r.key)
    rows.sort(key=keyfunc, reverse=reverse)
    return rows


__all__ = ["PartyTotal", "TRACK_BY", "TRACK_SORTS", "party_totals"]
