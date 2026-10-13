"""ACHBatch SQL helpers.

Read-side queries the SPA's /app/batches page consumes via the
controller. We pre-compute the per-batch transfers_total + count
in two bulk queries so we don't N+1 across rows.
"""
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from api.Modules.Batches.Models import ACHBatch
from api.Modules.Transfers.Models import PAYMENT_DEBIT_CARD, Transfer


# Sortable columns the controller exposes. Slugs match the
# legacy /batches route's `sort` query string for cutover parity.
SORT_COLUMNS: dict[str, Any] = {
    "ach_date":   ACHBatch.ach_date,
    "company":    ACHBatch.company,
    "batch_ref":  ACHBatch.batch_ref,
    "ach_amount": ACHBatch.ach_amount_cents,
    "status":     ACHBatch.status,
}


def list_batches_for_store(
    db: Session, store_id: int,
    *, sort: str = "", direction: str = "desc",
) -> list[ACHBatch]:
    """All ACH batches for a store, sorted. Empty `sort` falls
    back to the default (`ach_date desc`, then `id desc`)."""
    q = db.query(ACHBatch).filter(ACHBatch.store_id == store_id)
    col = SORT_COLUMNS.get(sort)
    if col is not None:
        q = q.order_by(
            col.asc() if direction == "asc" else col.desc(),
            ACHBatch.id.desc(),
        )
    else:
        q = q.order_by(
            ACHBatch.ach_date.desc(),
            ACHBatch.id.desc(),
        )
    return q.all()


def sum_transfer_totals_for_batch_refs(
    db: Session, store_id: int, batch_refs: list[str],
) -> dict[str, float]:
    """For a list of batch_ref strings, return a dict mapping
    each ref to Σ (send_amount + federal_tax) across the linked
    transfers.

    Note: the legacy ACHBatch.transfers_total property runs ONE
    query per batch — fine for a single row, expensive on a
    page of 50. This helper does it in one bulk query.

    Cancelled transfers are excluded (they keep their batch_id but
    never settle) so a voided transfer doesn't inflate the batch
    total / variance — same rule as the model property and
    summarize_transfers_for_day.
    """
    if not batch_refs:
        return {}
    rows = (
        db.query(
            Transfer.batch_id,
            (
                (func.coalesce(func.sum(Transfer.send_amount_cents), 0)
                 + func.coalesce(func.sum(Transfer.federal_tax_cents), 0)) / 100.0
            ).label("total"),
        )
        .filter(
            Transfer.store_id == store_id,
            Transfer.batch_id.in_(batch_refs),
            Transfer.status != "Cancelled",
            Transfer.is_send,
        )
        .group_by(Transfer.batch_id)
        .all()
    )
    return {r.batch_id: float(r.total or 0) for r in rows}


def transfer_count_by_batch_ref(
    db: Session, store_id: int, batch_refs: list[str],
) -> dict[str, int]:
    """Bulk-count transfers per batch_ref. Excludes Cancelled
    transfers to match transfers_total / the model properties."""
    if not batch_refs:
        return {}
    rows = (
        db.query(Transfer.batch_id, func.count(Transfer.id))
        .filter(
            Transfer.store_id == store_id,
            Transfer.batch_id.in_(batch_refs),
            Transfer.status != "Cancelled",
            Transfer.is_send,
        )
        .group_by(Transfer.batch_id)
        .all()
    )
    return {ref: int(c) for ref, c in rows}


def card_send_totals_for_batch_refs(
    db: Session, store_id: int, batch_refs: list[str],
) -> dict[str, int]:
    """For each batch_ref, Σ what customers paid by debit card
    (``send_amount + fee + federal_tax``, in cents) on the sends
    linked to it. The company credits that amount on its NEXT
    invoice (Transfers INVARIANTS "Debit card sends"). Cancelled
    transfers and payouts are excluded, as everywhere in batches."""
    if not batch_refs:
        return {}
    rows = (
        db.query(
            Transfer.batch_id,
            func.coalesce(func.sum(Transfer.send_amount_cents), 0)
            + func.coalesce(func.sum(Transfer.fee_cents), 0)
            + func.coalesce(func.sum(Transfer.federal_tax_cents), 0),
        )
        .filter(
            Transfer.store_id == store_id,
            Transfer.batch_id.in_(batch_refs),
            Transfer.status != "Cancelled",
            Transfer.is_send,
            Transfer.payment_method == PAYMENT_DEBIT_CARD,
        )
        .group_by(Transfer.batch_id)
        .all()
    )
    return {ref: int(c or 0) for ref, c in rows}


def company_batch_sequence(
    db: Session, store_id: int,
) -> list[tuple[int, str, str]]:
    """Every batch of the store as ``(id, company, batch_ref)``,
    ordered by company, then ACH date, then id: the order in which
    each company invoices the store. One batch's "next" batch is the
    following row of the same company."""
    rows = (
        db.query(ACHBatch.id, ACHBatch.company, ACHBatch.batch_ref)
        .filter(ACHBatch.store_id == store_id)
        .order_by(ACHBatch.company, ACHBatch.ach_date, ACHBatch.id)
        .all()
    )
    return [(int(i), c or "", r or "") for i, c, r in rows]
