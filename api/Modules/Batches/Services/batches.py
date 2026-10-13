"""ACH batch read-side service.

Wraps `list_batches_for_store` with the bulk transfer-total +
count lookups so each row arrives at the controller already
carrying its variance + count. Avoids the legacy
`ACHBatch.transfers_total` per-row N+1.

Debit card credits (Transfers INVARIANTS "Debit card sends"): a
debit card send is invoiced like any send on the batch it is linked
to, and the company credits what the customer paid on the card on
its NEXT invoice, i.e. that company's next batch by ACH date. So a
batch expects ``transfers_total - card_credit``, where
``card_credit`` is the card sends of the company's previous batch.
"""
from dataclasses import dataclass

from sqlalchemy.orm import Session

from api.Core.Money import to_dollars
from api.Modules.Batches.Models import ACHBatch
from api.Modules.Batches.Repositories import (
    card_send_totals_for_batch_refs,
    company_batch_sequence,
    list_batches_for_store,
    sum_transfer_totals_for_batch_refs,
    transfer_count_by_batch_ref,
)


@dataclass(frozen=True)
class CardCredit:
    """One batch's place in the debit card credit chain.

    * ``credit_cents`` / ``credit_from`` — card sends of the
      company's previous batch, credited on THIS ACH.
    * ``next_cents`` / ``next_to`` — card sends linked to this batch,
      credited on the next one (``next_to`` blank while the company
      has no later batch yet: the credit is still pending)."""
    credit_cents: int = 0
    credit_from: str = ""
    next_cents: int = 0
    next_to: str = ""


def card_credits_for_store(
    db: Session, store_id: int,
) -> dict[int, CardCredit]:
    """Batch id → its ``CardCredit``, for every batch of the store,
    in two queries."""
    seq = company_batch_sequence(db, store_id)
    card = card_send_totals_for_batch_refs(
        db, store_id, [ref for _, _, ref in seq if ref],
    )
    out: dict[int, CardCredit] = {}
    for i, (bid, company, ref) in enumerate(seq):
        prev = seq[i - 1] if i > 0 and seq[i - 1][1] == company else None
        nxt = (seq[i + 1] if i + 1 < len(seq) and seq[i + 1][1] == company
               else None)
        out[bid] = CardCredit(
            credit_cents=card.get(prev[2], 0) if prev else 0,
            credit_from=prev[2] if prev else "",
            next_cents=card.get(ref, 0),
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
    card: CardCredit = CardCredit()

    @property
    def card_credit(self) -> float:
        return to_dollars(self.card.credit_cents)

    @property
    def expected_ach(self) -> float:
        """What this ACH should withdraw: the linked sends, less the
        debit card credit from the company's previous batch."""
        return round(self.transfers_total - self.card_credit, 2)

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
    refs = [r.batch_ref for r in rows if r.batch_ref]
    totals = sum_transfer_totals_for_batch_refs(db, store_id, refs)
    counts = transfer_count_by_batch_ref(db, store_id, refs)
    cards = card_credits_for_store(db, store_id)
    return [
        BatchSummary(
            batch=r,
            transfers_total=totals.get(r.batch_ref, 0.0),
            transfer_count=counts.get(r.batch_ref, 0),
            card=cards.get(r.id, CardCredit()),
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
        card=card_credits_for_store(db, store_id).get(batch.id, CardCredit()),
    )
