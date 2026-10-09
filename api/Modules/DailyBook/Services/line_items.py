"""DailyLineItem write-side Service.

Add + delete operations for DailyLineItem rows + the
recompute-total helper that pushes the kind sum back onto the
DailyReport row's matching field. Validation lives here so a
malformed time/amount fails the same way regardless of whether the
request came in via Flask form-post or the future FastAPI
controller.
"""
from datetime import date, datetime, time
from typing import Iterable, cast

from sqlalchemy import func
from sqlalchemy.orm import Session

from api.Modules.DailyBook.Models import DailyLineItem
from api.Modules.DailyBook.Services.reports import ensure_daily_report
from api.Core.Clock import utc_now
from api.Core.Money import to_cents


class _Unset:
    """Sentinel for "argument not passed" where None is a real value."""


UNSET = _Unset()


class LineItemValidationError(ValueError):
    """User-facing validation failure. The message is safe to render
    to the cashier (matches the legacy form's flash strings)."""


def parse_at_time(raw: str) -> time:
    """Coerce a HH:MM form field into a datetime.time. Raises
    LineItemValidationError with the legacy "Enter a valid time
    (HH:MM)." message on parse failure."""
    try:
        return datetime.strptime(raw, "%H:%M").time()
    except (ValueError, TypeError):
        raise LineItemValidationError("Enter a valid time (HH:MM).")


def parse_amount(raw: str) -> float:
    """Coerce a form-field amount string to a positive float. Raises
    LineItemValidationError with the legacy "Amount must be greater
    than zero." message on parse failure or non-positive value."""
    try:
        amt = float(raw)
        if amt <= 0:
            raise ValueError
        return amt
    except (ValueError, TypeError):
        raise LineItemValidationError("Amount must be greater than zero.")


def add_line_item(
    db: Session, *, store_id: int, report_date: date,
    kind: str, at_time: time | None, amount: float,
    note: str = "", created_by: int | None = None,
    allowed_kinds: Iterable[str] | None = None,
    expects_settlement: bool = False,
    settle_by: date | None = None,
    settles_item_id: int | None = None,
) -> DailyLineItem:
    """Insert one DailyLineItem. Caller is responsible for committing
    the surrounding transaction (and for re-deriving the
    DailyReport's discriminated total from these rows after the
    insert).

    ``allowed_kinds`` is an optional whitelist — passing it makes
    the Service reject unknown kinds before the INSERT lands.
    Empty / None skips the check and trusts the caller.

    ``expects_settlement`` marks money that comes back (lent out or
    borrowed); ``settles_item_id`` books this entry as (part of) the
    return of an open one. See ``Services/settlements.py``.
    """
    from api.Modules.DailyBook.Services.settlements import (
        ALWAYS_OPEN_KINDS, SETTLES_ONLY_KINDS,
        check_expectation, check_settlement,
    )
    if allowed_kinds is not None and kind not in allowed_kinds:
        raise LineItemValidationError(f"Unknown line-item kind: {kind!r}")
    # Checks held are open by definition; a held-check deposit only
    # exists as the deposit OF a hold (INVARIANTS.md "Held checks").
    if kind in ALWAYS_OPEN_KINDS:
        expects_settlement = True
    if kind in SETTLES_ONLY_KINDS and settles_item_id is None:
        raise LineItemValidationError(
            "Record a held-check deposit with Deposit on the On hold tab "
            "of Check Deposits.",
        )
    if expects_settlement and settles_item_id is not None:
        raise LineItemValidationError(
            "An entry can't both settle another one and expect a return.",
        )
    if expects_settlement:
        check_expectation(kind, report_date, settle_by)
    elif settle_by is not None:
        raise LineItemValidationError(
            "A settle-by date needs the entry marked as coming back.",
        )
    if settles_item_id is not None:
        check_settlement(
            db, store_id=store_id, settles_item_id=settles_item_id,
            kind=kind, report_date=report_date,
            amount_cents=to_cents(amount),
        )
    row = DailyLineItem(
        store_id=store_id,
        report_date=report_date,
        kind=kind,
        at_time=at_time,
        amount=amount,
        note=(note or "").strip()[:120],
        created_by=created_by,
        expects_settlement=True if expects_settlement else None,
        settle_by=settle_by if expects_settlement else None,
        settles_item_id=settles_item_id,
    )
    db.add(row)
    db.flush()
    return row


def update_line_item(
    db: Session, line_item: DailyLineItem,
    *,
    at_time: time | None = None,
    amount: float | None = None,
    note: str | None = None,
    allow_return_check_linked: bool = False,
    expects_settlement: bool | None = None,
    settle_by: "date | None | _Unset" = UNSET,
) -> DailyLineItem:
    """Patch one DailyLineItem in place.  Caller fetches +
    scope-checks the row.  Only the fields whose argument was
    passed (not None) get written — partial PATCH semantics.

    Rejects updates on rows linked to a `ReturnCheck` (mirror of
    ReturnChecks-side state — daily-book edits can't drift those
    numbers).  Same guard as ``delete_line_item``.

    Caller commits the surrounding transaction and re-derives the
    DailyReport total via ``recompute_line_items_total`` after the
    update.
    """
    if (
        not allow_return_check_linked
        and line_item.return_check_id is not None
    ):
        raise LineItemValidationError(
            "This payback is linked to a return check. Edit it "
            "from Books → Return Checks (update the payment).",
        )
    from api.Modules.DailyBook.Services.settlements import (
        check_expectation, check_settlement, settled_cents,
    )
    store_id = int(line_item.store_id)
    item_id = int(line_item.id)
    # SQLAlchemy 1.x Column typing (see the setattr note below).
    item_date = cast(date, line_item.report_date)
    if amount is not None:
        if amount <= 0:
            raise LineItemValidationError(
                "Amount must be greater than zero.",
            )
        new_cents = to_cents(amount)
        # A return can't grow past what is still outstanding…
        if line_item.settles_item_id is not None:
            check_settlement(
                db, store_id=store_id,
                settles_item_id=int(line_item.settles_item_id),
                kind=str(line_item.kind),
                report_date=item_date,
                amount_cents=new_cents, exclude_id=item_id,
            )
        # …and a lent / borrowed entry can't shrink below what has
        # already come back.
        returned = settled_cents(db, store_id, [item_id]).get(item_id, 0)
        if new_cents < returned:
            raise LineItemValidationError(
                "Returns already recorded against this entry add up to "
                "more than that amount.",
            )
        # `setattr` rather than direct assignment — SQLAlchemy 1.x
        # column descriptors expose `Column[float]` to mypy, which
        # rejects `float` assignments under --strict.  Same trick
        # `recompute_line_items_total` uses below.
        setattr(line_item, "amount", float(amount))
    if at_time is not None:
        setattr(line_item, "at_time", at_time)
    if note is not None:
        setattr(line_item, "note", note.strip()[:120])
    marked = (
        bool(line_item.expects_settlement)
        if expects_settlement is None else expects_settlement
    )
    if expects_settlement is not None:
        if expects_settlement:
            if line_item.settles_item_id is not None:
                raise LineItemValidationError(
                    "A return can't itself be marked as coming back.",
                )
            check_expectation(
                str(line_item.kind), item_date,
                None if isinstance(settle_by, _Unset) else settle_by,
            )
        # Unticking is "close": the entry leaves the open list; any
        # returns already recorded stay linked to it.
        setattr(line_item, "expects_settlement", True if marked else None)
        if not marked:
            setattr(line_item, "settle_by", None)
    if not isinstance(settle_by, _Unset):
        if settle_by is not None:
            if not marked:
                raise LineItemValidationError(
                    "A settle-by date needs the entry marked as coming back.",
                )
            check_expectation(
                str(line_item.kind), item_date, settle_by,
            )
        setattr(line_item, "settle_by", settle_by if marked else None)
    db.flush()
    return line_item


def delete_line_item(
    db: Session, line_item: DailyLineItem,
    *, allow_return_check_linked: bool = False,
) -> None:
    """Delete one DailyLineItem. Caller fetches + scope-checks the row.

    `allow_return_check_linked=False` is the default so the manual
    delete path can't strip a payback that was created by the Return
    Checks page (the daily book stays in sync with that source of
    truth). Pass True from the Return-Checks-side delete to allow it.
    """
    if (
        not allow_return_check_linked
        and line_item.return_check_id is not None
    ):
        raise LineItemValidationError(
            "This payback is linked to a return check. Remove it "
            "from Books → Return Checks (delete the payment).",
        )
    from api.Modules.DailyBook.Services.settlements import settled_cents
    item_id = int(line_item.id)
    if settled_cents(db, int(line_item.store_id), [item_id]).get(item_id):
        raise LineItemValidationError(
            "Returns are recorded against this entry. Remove them "
            "first, then remove this entry.",
        )
    db.delete(line_item)
    db.flush()


def recompute_line_items_total(
    db: Session, store_id: int, report_date: date,
    *, kind: str, daily_report_field: str,
) -> float:
    """Sum DailyLineItem rows of the given kind for (store, date) and
    push the total onto the matching DailyReport field.

    `daily_report_field` is the attribute name on DailyReport that
    stores the rolled-up total for `kind` (e.g. `cash_purchase` →
    `cash_purchases`). The legacy `_LINE_ITEM_KINDS` map in app.py
    holds the kind→field mapping; the Service takes the field name
    explicitly so it doesn't have to know about the registry yet.

    Caller commits. Returns the total (useful for log output / test
    assertions).
    """
    total = (
        db.query(func.coalesce(func.sum(DailyLineItem.amount_cents), 0) / 100.0)
          .filter_by(
              store_id=store_id,
              report_date=report_date,
              kind=kind,
          )
          .scalar()
    ) or 0.0
    report = ensure_daily_report(db, store_id, report_date)
    setattr(report, daily_report_field, float(total))
    # Over/Short is a derived reconciliation over these line-item totals
    # (drops, deposits, purchases, expenses…), so it has to be refreshed
    # here too — not just on the report PUT. Keeps the stored column
    # correct after a line-item add/edit/delete. (setattr to dodge the
    # SQLAlchemy 1.x Column[float] typing trap, matching above.)
    setattr(report, "over_short", report.computed_over_short)
    setattr(report, "updated_at", utc_now())
    db.flush()
    return float(total)
