"""ACH batch read-side service.

Wraps `list_batches_for_store` with the bulk transfer-total +
count lookups so each row arrives at the controller already
carrying its variance + count. Avoids the legacy
`ACHBatch.transfers_total` per-row N+1.

Credits on the next invoice (Transfers INVARIANTS "Debit card sends"
/ "Payouts"): the company credits two things on its NEXT invoice, i.e.
that company's next batch by ACH date:

* a debit card send: invoiced like any send on its own batch, then
  what the customer paid on the card comes back as a credit;
* a payout: cash the store paid out for the company, never invoiced,
  credited at the amount paid out.

So a batch expects ``transfers_total - card_credit - payout_credit``,
both credits coming from the company's previous batch.
"""
from dataclasses import dataclass

from sqlalchemy.orm import Session

from api.Core.Money import to_dollars
from api.Core.Pagination import PaginationParams, paginate
from api.Modules.Batches.Models import ACHBatch
from api.Modules.Batches.Repositories import (
    batches_query,
    credit_totals_for_batch_refs,
    company_batch_sequence,
    list_batches_for_store,
    sum_transfer_totals_for_batch_refs,
    transfer_count_by_batch_ref,
)


@dataclass(frozen=True)
class BatchCredit:
    """One batch's place in the credit chain, in cents.

    * ``card_cents`` / ``payout_cents`` / ``credit_from`` — the
      previous batch's debit card sends and payouts, credited on
      THIS ACH.
    * ``card_next_cents`` / ``payout_next_cents`` / ``next_to`` —
      the ones linked to this batch, credited on the next one
      (``next_to`` blank while the company has no later batch yet:
      the credit is still pending)."""
    card_cents: int = 0
    payout_cents: int = 0
    credit_from: str = ""
    card_next_cents: int = 0
    payout_next_cents: int = 0
    next_to: str = ""

    @property
    def credit_cents(self) -> int:
        return self.card_cents + self.payout_cents


def credits_for_store(
    db: Session, store_id: int,
) -> dict[int, BatchCredit]:
    """Batch id → its ``BatchCredit``, for every batch of the store,
    in two queries."""
    seq = company_batch_sequence(db, store_id)
    totals = credit_totals_for_batch_refs(
        db, store_id, [ref for _, _, ref in seq if ref],
    )
    out: dict[int, BatchCredit] = {}
    for i, (bid, company, ref) in enumerate(seq):
        prev = seq[i - 1] if i > 0 and seq[i - 1][1] == company else None
        nxt = (seq[i + 1] if i + 1 < len(seq) and seq[i + 1][1] == company
               else None)
        card, payout = totals.get(prev[2], (0, 0)) if prev else (0, 0)
        card_next, payout_next = totals.get(ref, (0, 0))
        out[bid] = BatchCredit(
            card_cents=card,
            payout_cents=payout,
            credit_from=prev[2] if prev else "",
            card_next_cents=card_next,
            payout_next_cents=payout_next,
            next_to=nxt[2] if nxt else "",
        )
    return out


@dataclass
class BatchSummary:
    """Service-layer DTO for one ACH batch with precomputed
    totals. Controllers convert this into the wire schema."""
    batch: ACHBatch
    transfers_total: float
    transfer_count: int
    credit: BatchCredit = BatchCredit()

    @property
    def expected_ach(self) -> float:
        """What this ACH should withdraw: the linked sends, less the
        debit card and payout credits from the company's previous
        batch."""
        return round(
            self.transfers_total - to_dollars(self.credit.credit_cents), 2,
        )

    @property
    def variance(self) -> float:
        return round((self.batch.ach_amount or 0) - self.expected_ach, 2)


def list_store_batches(
    db: Session, store_id: int,
    *, sort: str = "", direction: str = "desc",
) -> list[BatchSummary]:
    """All batches for one store with totals + counts pre-bulked.
    Returns Service DTOs in the same order the Repository sort
    produced."""
    rows = list_batches_for_store(
        db, store_id, sort=sort, direction=direction,
    )
    return _summaries(db, store_id, rows)


def page_store_batches(
    db: Session, store_id: int, pagination: PaginationParams,
    *, sort: str = "", direction: str = "desc",
) -> tuple[list[BatchSummary], int, int]:
    """One page of the store's batches, sorted across every page
    before slicing. Returns ``(summaries, total, total_pages)``.
    Credits are worked out over the whole store, so a batch on page
    two still sees the credit its predecessor on page one passes on."""
    payload = paginate(
        batches_query(db, store_id, sort=sort, direction=direction),
        pagination,
    )
    return (
        _summaries(db, store_id, payload["rows"]),
        int(payload["total"]),
        int(payload["total_pages"]),
    )


def _summaries(
    db: Session, store_id: int, rows: list[ACHBatch],
) -> list[BatchSummary]:
    refs = [r.batch_ref for r in rows if r.batch_ref]
    totals = sum_transfer_totals_for_batch_refs(db, store_id, refs)
    counts = transfer_count_by_batch_ref(db, store_id, refs)
    credits = credits_for_store(db, store_id)
    return [
        BatchSummary(
            batch=r,
            transfers_total=totals.get(r.batch_ref, 0.0),
            transfer_count=counts.get(r.batch_ref, 0),
            credit=credits.get(r.id, BatchCredit()),
        )
        for r in rows
    ]


def summarize_batch(
    db: Session, store_id: int, batch: ACHBatch,
) -> BatchSummary:
    """One batch with the same totals ``list_store_batches`` gives
    each row (detail, create and edit responses)."""
    refs = [batch.batch_ref] if batch.batch_ref else []
    totals = sum_transfer_totals_for_batch_refs(db, store_id, refs)
    counts = transfer_count_by_batch_ref(db, store_id, refs)
    return BatchSummary(
        batch=batch,
        transfers_total=totals.get(batch.batch_ref, 0.0),
        transfer_count=counts.get(batch.batch_ref, 0),
        credit=credits_for_store(db, store_id).get(batch.id, BatchCredit()),
    )
