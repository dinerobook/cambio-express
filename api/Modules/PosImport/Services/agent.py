"""PosImport — site-agent credentials + journal staging.

Phase B of the Gilbarco wedge: a thin watcher installed at the
store pushes each new journal file to the API the moment Passport
writes it. The agent is deliberately dumb (HANDOFF.md §2 — parse
stays server-side so fleet agents never need updates for parser
work): it authenticates with a per-store key, sends the raw file,
and the server does everything else.

* Keys: "pak_…" shown once, stored as sha256 (invariant #10
  contract). Revoke + re-issue; ``last_used_at`` doubles as the
  agent heartbeat.
* Staging: one ``PosJournalFile`` row per pushed file, unique on
  (store, filename) so agent retries are idempotent. Raw XML is
  kept gzipped so day commits re-parse originals and parser fixes
  can re-book history.
* Commit: the operator books a staged business day through the
  same ``commit_business_day`` path as manual uploads — same
  mapping gate, same audit, same idempotent day replacement.
"""
from __future__ import annotations

import gzip
import hashlib
import secrets
from dataclasses import dataclass
from datetime import date

from sqlalchemy import func
from sqlalchemy.orm import Session

from api.Core.Clock import utc_now

from api.Modules.DayClose.Models import RegisterClose
from api.Modules.PosImport.Models import (
    PosAgentCredential,
    PosJournalFile,
)
from api.Modules.PosImport.Services.ingest import (
    IMPORT_SOURCE,
    CommitDayResult,
    PosImportError,
)
from api.Modules.PosImport.Services.naxml import (
    PjrEvent,
    PosJournalParseError,
    parse_pjr,
)

KEY_PREFIX = "pak_"
MAX_AGENT_FILE_BYTES = 4 * 1024 * 1024


def _hash(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode()).hexdigest()


# ── Credentials ────────────────────────────────────────────


def issue_agent_key(
    db: Session, store_id: int, *, label: str = "",
) -> tuple[PosAgentCredential, str]:
    """Mint a new agent key. The raw value is returned exactly
    once — only the hash is stored."""
    raw = KEY_PREFIX + secrets.token_urlsafe(32)
    cred = PosAgentCredential(
        store_id=store_id, key_hash=_hash(raw), label=label.strip(),
    )
    db.add(cred)
    db.flush()
    return cred, raw


def list_agent_keys(
    db: Session, store_id: int,
) -> list[PosAgentCredential]:
    return (
        db.query(PosAgentCredential)
        .filter_by(store_id=store_id)
        .order_by(PosAgentCredential.created_at.desc())
        .all()
    )


def revoke_agent_key(
    db: Session, store_id: int, key_id: int,
) -> PosAgentCredential:
    cred = db.get(PosAgentCredential, key_id)
    if cred is None or cred.store_id != store_id:
        raise PosImportError("Agent key not found")
    if cred.revoked_at is None:
        cred.revoked_at = utc_now()
        db.flush()
    return cred


def authenticate_agent(
    db: Session, raw_key: str,
) -> PosAgentCredential | None:
    """Resolve a presented key to its live credential, stamping the
    heartbeat. None for unknown/revoked (caller returns an opaque
    401 — no enumeration hints)."""
    if not raw_key or not raw_key.startswith(KEY_PREFIX):
        return None
    cred = (
        db.query(PosAgentCredential)
        .filter_by(key_hash=_hash(raw_key))
        .first()
    )
    if cred is None or cred.revoked_at is not None:
        return None
    cred.last_used_at = utc_now()
    db.flush()
    return cred


@dataclass(frozen=True)
class AgentStoreBlock:
    status_code: int
    detail: str
    reason: str


def agent_store_block(db: Session, store_id: int) -> AgentStoreBlock | None:
    """Why this store's agent may not upload, or None when it may.

    An agent key sends no JWT, so neither the subscription gate
    (``SubscriptionGateMiddleware`` finds the store through the
    token) nor the disabled-store check in ``get_principal`` ever
    sees an upload. Both rules are asked here instead, with the
    answers a signed-in write gets: 403 for a store the superadmin
    disabled (``store_access``), 402 with ``write_block_reason``'s
    reason for a frozen store or a lapsed trial / subscription. A
    store row that is gone counts as disabled (fail closed). The
    site agent keeps refused files and sends them once the store is
    open again."""
    from api.Core.Subscription import write_block_reason
    from api.Modules.Auth.Services.store_access import (
        STORE_DISABLED_MESSAGE,
        store_is_active,
    )
    from api.Modules.Tenancy.Models import Store

    store = db.get(Store, store_id)
    if store is None or not store_is_active(store):
        return AgentStoreBlock(403, STORE_DISABLED_MESSAGE, "store_disabled")
    blocked = write_block_reason(store)
    if blocked is not None:
        reason, message = blocked
        return AgentStoreBlock(402, message, reason)
    return None


# ── Staging ────────────────────────────────────────────────


@dataclass
class StageResult:
    file: PosJournalFile
    duplicate: bool
    # A fuel prepay completion for a deposit on an EARLIER business
    # day that is already booked: that day still counts the deposit
    # and needs re-booking (``rebook_for_late_completion``).
    rebook_day: date | None = None


def _staged_prepay_partners(
    db: Session, store_id: int, key: str, filename: str,
) -> list[PjrEvent]:
    """The other staged half (or halves) of a prepaid ticket: files
    sharing ``key``, parsed. Unparseable files are skipped."""
    if not key:
        return []
    rows = (
        db.query(PosJournalFile)
        .filter(
            PosJournalFile.store_id == store_id,
            PosJournalFile.prepay_key == key,
            PosJournalFile.filename != filename,
        )
        .order_by(PosJournalFile.id)
        .all()
    )
    partners: list[PjrEvent] = []
    for f in rows:
        try:
            partner = parse_pjr(gzip.decompress(f.content_gz))
        except (PosJournalParseError, OSError):
            continue
        partner.source_file = f.filename
        partners.append(partner)
    return partners


def _bump_hourly(
    db: Session, store_id: int, day: date, hour: int, cents: int,
) -> None:
    from api.Modules.DayClose.Models import HourlySale

    bucket = (
        db.query(HourlySale)
        .filter_by(
            store_id=store_id, report_date=day, hour=hour,
            source=IMPORT_SOURCE,
        )
        .first()
    )
    if bucket is None:
        db.add(HourlySale(
            store_id=store_id, report_date=day, hour=hour,
            amount_cents=cents, source=IMPORT_SOURCE,
        ))
    else:
        bucket.amount_cents = int(bucket.amount_cents or 0) + cents


def stage_journal_file(
    db: Session, store_id: int, *, filename: str, content: bytes,
) -> StageResult:
    """Store one pushed journal file. Idempotent on (store,
    filename) — the agent can retry safely. Files that fail to
    parse are staged anyway with the error recorded (a future
    parser fix re-parses them at commit time).

    A prepaid fuel ticket arrives twice (deposit, then the
    completion that restates it — naxml module docstring). The live
    hourly preview counts it once whichever half lands first, and a
    completion whose deposit sits on an earlier, already-booked day
    reports that day in ``rebook_day``."""
    filename = filename.strip().rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if not filename:
        raise PosImportError("Filename is required.")
    if len(content) > MAX_AGENT_FILE_BYTES:
        raise PosImportError("File too large.")

    existing = (
        db.query(PosJournalFile)
        .filter_by(store_id=store_id, filename=filename)
        .first()
    )
    if existing is not None:
        return StageResult(file=existing, duplicate=True)

    business_date: date | None = None
    event_kind = ""
    parse_error = ""
    event = None
    try:
        event = parse_pjr(content)
        business_date = event.business_date
        event_kind = event.kind
    except PosJournalParseError as exc:
        parse_error = str(exc)[:255]

    prepay_key = event.prepay_key if event is not None else ""
    partners = (
        _staged_prepay_partners(db, store_id, prepay_key, filename)
        if event is not None and (
            event.is_prepay_deposit or event.completes_prepay
        ) else []
    )
    deposit = next(
        (p for p in partners if p.is_prepay_deposit), None,
    ) if event is not None and event.completes_prepay else None

    # G-3 live hourly preview: increment the hour bucket as each
    # sale/refund arrives so the dashboard's hourly chart tracks
    # the CURRENT business day in near-real-time, on the same
    # pre-tax basis as the booked gross_sales. Commit rebuilds
    # the day from the staged originals, self-healing any drift
    # (e.g. an upload that raced or a later parser fix). Runs
    # only for brand-new files — the duplicate short-circuit above
    # already returned, so retries never double-count.
    if (
        event is not None
        and event.counts_toward_sales
        and business_date is not None
        and event.event_hour is not None
        # A deposit whose completion already arrived (out of order)
        # is superseded — the completion is in the preview.
        and not (
            event.is_prepay_deposit
            and any(p.completes_prepay for p in partners)
        )
    ):
        _bump_hourly(
            db, store_id, business_date, event.event_hour,
            event.sales_cents,
        )
    # A completion restates its deposit: take the deposit back out
    # of the preview, so the ticket counts once, from here.
    if (
        deposit is not None
        and deposit.business_date is not None
        and deposit.event_hour is not None
    ):
        _bump_hourly(
            db, store_id, deposit.business_date, deposit.event_hour,
            -deposit.sales_cents,
        )

    rebook_day: date | None = None
    if (
        deposit is not None
        and deposit.business_date is not None
        and business_date is not None
        and deposit.business_date < business_date
        and db.query(RegisterClose.id).filter_by(
            store_id=store_id, report_date=deposit.business_date,
            source=IMPORT_SOURCE,
        ).first() is not None
    ):
        rebook_day = deposit.business_date

    row = PosJournalFile(
        store_id=store_id,
        filename=filename,
        business_date=business_date,
        event_kind=event_kind,
        parse_error=parse_error,
        content_gz=gzip.compress(content),
        prepay_key=prepay_key[:80],
    )
    db.add(row)
    db.flush()
    return StageResult(file=row, duplicate=False, rebook_day=rebook_day)


@dataclass
class StagedDay:
    business_date: date
    file_count: int
    error_count: int
    committed: bool


def staged_days(db: Session, store_id: int) -> list[StagedDay]:
    """Business days with staged files, newest first, flagged when
    the day already has imported closes (i.e. was committed —
    possibly before more files arrived)."""
    rows = (
        db.query(
            PosJournalFile.business_date,
            func.count(PosJournalFile.id),
        )
        .filter(
            PosJournalFile.store_id == store_id,
            PosJournalFile.business_date.isnot(None),
        )
        .group_by(PosJournalFile.business_date)
        .order_by(PosJournalFile.business_date.desc())
        .all()
    )
    error_days = {
        d for (d,) in db.query(PosJournalFile.business_date)
        .filter(
            PosJournalFile.store_id == store_id,
            PosJournalFile.parse_error != "",
            PosJournalFile.business_date.isnot(None),
        )
        .distinct()
        .all()
    }
    committed_days = {
        d for (d,) in db.query(RegisterClose.report_date)
        .filter(
            RegisterClose.store_id == store_id,
            RegisterClose.source == IMPORT_SOURCE,
        )
        .distinct()
        .all()
    }
    out = []
    for day, count in rows:
        errors = 0
        if day in error_days:
            errors = (
                db.query(func.count(PosJournalFile.id))
                .filter_by(
                    store_id=store_id, business_date=day,
                )
                .filter(PosJournalFile.parse_error != "")
                .scalar()
            ) or 0
        out.append(StagedDay(
            business_date=day,
            file_count=int(count),
            error_count=int(errors),
            committed=day in committed_days,
        ))
    return out


AUTO_COMMIT_LOOKBACK_DAYS = 3


def auto_commit_rolled_days(db: Session, store_id: int) -> list:
    """Auto-book recently ROLLED business days (G-1 — the
    hands-off ingestion loop). Called after each agent upload; a
    day D is booked only when every gate passes:

      * a staged file with a NEWER business date exists — the
        site's day has rolled (Passport's BusinessDate advances at
        the site day close, so this is the authoritative "day D is
        complete" signal),
      * D has NO RegisterClose rows from ANY source — manual
        entries are never doubled up, and late files for an
        already-booked day stay a manual re-commit (which replaces
        idempotently),
      * no file for D has a parse error (a parser fix re-parses
        history — don't book a known-partial day),
      * D is inside a short lookback window — the backlog from a
        fresh agent install stays a reviewed, manual warm start,
      * every merchandise code is mapped (commit_business_day's
        gate) — an unmapped day is skipped silently and retried on
        the next upload, so mapping completion is all an operator
        needs to do.

    Each booked day writes a system operator-audit row. Caller
    commits. Returns the CommitDayResult list (empty = nothing was
    ready)."""
    from datetime import timedelta

    from api.Modules.Audit.Services import record_operator_action
    from api.Modules.PosImport.Services.ingest import (
        PosImportError,
        commit_business_day,
    )

    latest = (
        db.query(func.max(PosJournalFile.business_date))
        .filter(
            PosJournalFile.store_id == store_id,
            PosJournalFile.business_date.isnot(None),
        )
        .scalar()
    )
    if latest is None:
        return []
    window_start = latest - timedelta(days=AUTO_COMMIT_LOOKBACK_DAYS)
    candidates = [
        d for (d,) in db.query(PosJournalFile.business_date)
        .filter(
            PosJournalFile.store_id == store_id,
            PosJournalFile.business_date.isnot(None),
            PosJournalFile.business_date < latest,
            PosJournalFile.business_date >= window_start,
        )
        .distinct()
        .all()
    ]
    if not candidates:
        return []
    booked_dates = {
        d for (d,) in db.query(RegisterClose.report_date)
        .filter(
            RegisterClose.store_id == store_id,
            RegisterClose.report_date.in_(candidates),
        )
        .distinct()
        .all()
    }
    error_dates = {
        d for (d,) in db.query(PosJournalFile.business_date)
        .filter(
            PosJournalFile.store_id == store_id,
            PosJournalFile.business_date.in_(candidates),
            PosJournalFile.parse_error != "",
        )
        .distinct()
        .all()
    }
    results = []
    for day in sorted(candidates):
        if day in booked_dates or day in error_dates:
            continue
        events = staged_events_for_day(db, store_id, day)
        try:
            result = commit_business_day(
                db, store_id, day, events=events, created_by=None,
            )
        except PosImportError:
            # Unmapped codes (or an empty day) — leave it staged;
            # the next upload retries after the operator maps.
            continue
        record_operator_action(
            db,
            store_id=store_id,
            user_id=None,
            user_name="Gilbarco site agent",
            user_role="system",
            target_type="register_close",
            target_id=day.isoformat(),
            action="commit_pos_import_auto",
            summary=(
                f"auto-booked rolled day {day.isoformat()}: "
                f"{result.closes_written} register close(s)"
            ),
        )
        results.append(result)
    return results


def rebook_for_late_completion(
    db: Session, store_id: int, day: date,
) -> CommitDayResult | None:
    """Re-book ``day`` after a fuel prepay taken on it was completed
    on a LATER business day that arrived once ``day`` was booked.

    Auto-commit books a day as soon as the next day's first file
    lands, and a prepay rung just before the site's day close is
    completed after it — so the booked day still counts a deposit
    the completion now restates. Re-committing from the staged files
    lets ``commit_business_day`` find the completion and drop the
    deposit, keeping the drawer count and any typed note, as every
    re-commit does.

    Refused (None) when the day is not booked from the journal, or
    when its stored transactions hold a file that was never staged:
    such a day was booked from a manual upload, and re-booking it
    from staged files alone would drop that upload's tickets. The
    operator re-commits it by hand. Caller commits."""
    from api.Modules.Audit.Services import record_operator_action
    from api.Modules.PosImport.Models import PosTransaction
    from api.Modules.PosImport.Services.ingest import commit_business_day

    booked = (
        db.query(RegisterClose)
        .filter_by(store_id=store_id, report_date=day, source=IMPORT_SOURCE)
        .first()
    )
    if booked is None:
        return None
    staged_names = (
        db.query(PosJournalFile.filename)
        .filter_by(store_id=store_id, business_date=day)
    )
    upload_only = (
        db.query(PosTransaction.id)
        .filter(
            PosTransaction.store_id == store_id,
            PosTransaction.business_date == day,
            PosTransaction.source_file.notin_(staged_names),
        )
        .first()
    )
    if upload_only is not None:
        return None
    try:
        result = commit_business_day(
            db, store_id, day,
            events=staged_events_for_day(db, store_id, day),
            created_by=booked.created_by,
        )
    except PosImportError:
        return None
    record_operator_action(
        db,
        store_id=store_id,
        user_id=None,
        user_name="Gilbarco site agent",
        user_role="system",
        target_type="register_close",
        target_id=day.isoformat(),
        action="commit_pos_import_auto",
        summary=(
            f"re-booked {day.isoformat()}: a fuel prepay taken that day "
            f"was completed on a later business day"
        ),
    )
    return result


def staged_events_for_day(
    db: Session, store_id: int, day: date,
) -> list[PjrEvent]:
    """Re-parse the staged originals for one business day. Files
    whose stored parse_error persists are skipped (they were never
    counted toward the day either)."""
    files = (
        db.query(PosJournalFile)
        .filter_by(store_id=store_id, business_date=day)
        .all()
    )
    events: list[PjrEvent] = []
    for f in files:
        try:
            event = parse_pjr(gzip.decompress(f.content_gz))
        except (PosJournalParseError, OSError):
            continue
        # Carry the filename through so the persisted transaction
        # (G-5) can key on it and stay idempotent across re-commits.
        event.source_file = f.filename
        events.append(event)
    return events


__all__ = [
    "KEY_PREFIX", "MAX_AGENT_FILE_BYTES", "AgentStoreBlock", "StageResult",
    "StagedDay", "agent_store_block",
    "authenticate_agent", "issue_agent_key", "list_agent_keys",
    "rebook_for_late_completion", "revoke_agent_key",
    "stage_journal_file", "staged_days", "staged_events_for_day",
]
