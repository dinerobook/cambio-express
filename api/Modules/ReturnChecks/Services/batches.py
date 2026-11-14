"""Returned batches: the checks the bank sent back together.

A batch owns the returned date of its checks and carries no money of
its own — its totals are worked out from its checks, and every check
keeps its own paybacks, status and P&L effect exactly as a single
entry does. Caller commits.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date

from sqlalchemy.orm import Session

from api.Core.Clock import utc_now
from api.Modules.ReturnChecks.Models import ReturnCheck, ReturnCheckBatch
from api.Modules.ReturnChecks.Repositories import find_batch
from api.Modules.ReturnChecks.Services import (
    ReturnCheckBatchNotFoundError, ReturnCheckStateError,
    ReturnCheckWriteInput, create_return_check,
)


@dataclass
class BatchWriteInput:
    returned_on: date
    reference: str = ""
    notes: str = ""
    checks: list[ReturnCheckWriteInput] = field(default_factory=list)


@dataclass
class BatchTotals:
    check_count: int
    amount_cents: int
    fee_cents: int
    recovered_cents: int
    open_count: int
    companies: list[str]


def batch_totals(batch: ReturnCheckBatch) -> BatchTotals:
    """What a batch adds up to, from its checks."""
    checks = list(batch.checks or [])
    companies: list[str] = []
    for c in checks:
        name = (c.company_name or "").strip()
        if name and name not in companies:
            companies.append(name)
    return BatchTotals(
        check_count=len(checks),
        amount_cents=sum(int(c.amount_cents or 0) for c in checks),
        fee_cents=sum(int(c.return_check_fee_cents or 0) for c in checks),
        recovered_cents=sum(c.recovered_total_cents for c in checks),
        open_count=sum(1 for c in checks if c.status == "pending"),
        companies=companies,
    )


def create_batch(
    db: Session, *, store_id: int, created_by: int | None,
    payload: BatchWriteInput,
) -> tuple[ReturnCheckBatch, list[ReturnCheck]]:
    """Insert the batch and each of its checks (pending, dated the
    batch's returned day). Returns the batch and the new checks."""
    batch = ReturnCheckBatch(
        store_id=store_id,
        returned_on=payload.returned_on,
        reference=payload.reference.strip(),
        notes=payload.notes,
        created_by=created_by,
    )
    db.add(batch)
    db.flush()
    checks = [
        create_return_check(
            db, store_id=store_id, created_by=created_by,
            payload=replace(
                check, bounced_on=payload.returned_on, batch_id=int(batch.id),
            ),
        )
        for check in payload.checks
    ]
    db.flush()
    return batch, checks


def update_batch(
    db: Session, *, store_id: int, batch_id: int,
    returned_on: date, reference: str, notes: str,
) -> ReturnCheckBatch:
    """Edit the batch; a new returned date moves every check in it
    (the date a check came back is not money — status dates drive the
    P&L, and they do not change here)."""
    batch = find_batch(db, store_id, batch_id)
    if batch is None:
        raise ReturnCheckBatchNotFoundError(f"id={batch_id}")
    batch.returned_on = returned_on
    batch.reference = reference.strip()
    batch.notes = notes
    batch.updated_at = utc_now()
    for check in batch.checks or []:
        check.bounced_on = returned_on
    db.flush()
    return batch


def delete_batch(db: Session, *, store_id: int, batch_id: int) -> ReturnCheckBatch:
    """Delete an EMPTY batch (a mistake, or every check moved out).
    A batch with checks is refused: returned checks are never
    deleted, so their batch stays too."""
    batch = find_batch(db, store_id, batch_id)
    if batch is None:
        raise ReturnCheckBatchNotFoundError(f"id={batch_id}")
    if batch.checks:
        raise ReturnCheckStateError(
            "This batch still has checks. Move them to another batch "
            "before deleting it.",
        )
    db.delete(batch)
    db.flush()
    return batch


__all__ = [
    "BatchTotals", "BatchWriteInput", "batch_totals", "create_batch",
    "delete_batch", "update_batch",
]
