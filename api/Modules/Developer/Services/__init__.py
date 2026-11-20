"""Developer — the store's import files, for a superadmin inside it.

Every file the register sent is already kept: ``PosJournalFile``
(``retail_pos_journal_file``) stages each upload with its gzipped
raw XML and, when it could not be read, the reason
(``parse_error``). This module only reads those rows — it books
nothing and changes nothing.

"Not imported" means the readers could not read the file (it is
not well-formed XML, not a Passport document, or holds no event
they know), so nothing from it reached any tab. A file that did
read is "imported"; whether its day is booked yet is the POS import
page's business, not this list's.
"""
from __future__ import annotations

import codecs
import gzip
import re
from datetime import date
from typing import Any

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session, load_only

from api.Core.Clock import iso_or_none
from api.Core.Pagination import PaginationParams, paginate
from api.Modules.PosImport.Models import PosJournalFile
from api.Modules.PosImport.Services.movement import MOVEMENT_KIND

KIND_JOURNAL = "journal"
KIND_MOVEMENT = "movement"
KIND_UNKNOWN = "unknown"
KINDS = ("", KIND_JOURNAL, KIND_MOVEMENT, KIND_UNKNOWN)

STATUS_NOT_IMPORTED = "not_imported"
STATUS_IMPORTED = "imported"
STATUSES = ("", STATUS_NOT_IMPORTED, STATUS_IMPORTED)

# ``PosJournalFile`` declares ``Column(...)`` attributes, which mypy
# types as ``Column[T]`` rather than ORM attributes (api/CLAUDE.md,
# mypy "Known traps"): these two tables are typed ``Any`` for that.
SORTS: dict[str, Any] = {
    "received": PosJournalFile.received_at,
    "business_date": PosJournalFile.business_date,
    "filename": PosJournalFile.filename,
}

# What a list row needs — never ``content_gz``, the file itself.
_LIST_COLUMNS: tuple[Any, ...] = (
    PosJournalFile.id, PosJournalFile.filename,
    PosJournalFile.business_date, PosJournalFile.event_kind,
    PosJournalFile.parse_error, PosJournalFile.received_at,
)

# The page shows a file up to this size; the raw route always sends
# all of it. Real Passport files are a few KB (the largest of
# 105,171 was 128 KB); an upload may be up to 4 MB.
SHOW_LIMIT_BYTES = 2 * 1024 * 1024

# XML without a declaration is UTF-8 by the XML spec. Passport
# declares ISO-8859-1.
_DEFAULT_ENCODING = "utf-8"
_DECLARED = re.compile(
    rb"""^\s*<\?xml[^>]*?encoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']""",
)


class DeveloperQueryError(ValueError):
    """A filter the list does not know (the message is user-safe)."""


def is_developer(db: Session, claims: dict[str, Any]) -> bool:
    """True only on an impersonation token whose impersonator is
    still an active superadmin. The store's own people, owners and
    accountants are never developers, whatever they are granted."""
    by = claims.get("impersonated_by")
    if by is None:
        return False
    try:
        user_id = int(by)
    except (TypeError, ValueError):
        return False
    from api.Modules.Tenancy.Models import User
    user = db.get(User, user_id)
    if user is None:
        return False
    return str(user.role or "") == "superadmin" and bool(user.is_active)


def store_name(db: Session, store_id: int) -> str:
    from api.Modules.Tenancy.Models import Store
    store = db.get(Store, store_id)
    return str(store.name or "") if store is not None else ""


def _kind_of(event_kind: str) -> str:
    if event_kind == MOVEMENT_KIND:
        return KIND_MOVEMENT
    return KIND_JOURNAL if event_kind else KIND_UNKNOWN


def file_row(f: PosJournalFile) -> dict[str, Any]:
    event_kind = str(f.event_kind or "")
    reason = str(f.parse_error or "")
    return {
        "id": int(f.id),
        "filename": str(f.filename),
        "kind": _kind_of(event_kind),
        "event_kind": event_kind,
        "business_date": (
            f.business_date.isoformat() if f.business_date else None
        ),
        "received_at": iso_or_none(f.received_at),
        "imported": not reason,
        "reason": reason,
    }


def summary(db: Session, store_id: int) -> dict[str, Any]:
    """Every file the store has, whatever the list's filters."""
    total, not_imported, last = (
        db.query(
            func.count(PosJournalFile.id),
            func.sum(case((PosJournalFile.parse_error != "", 1), else_=0)),
            func.max(PosJournalFile.received_at),
        )
        .filter(PosJournalFile.store_id == store_id)
        .one()
    )
    return {
        "files": int(total or 0),
        "not_imported": int(not_imported or 0),
        "last_received_at": iso_or_none(last),
    }


def list_files(
    db: Session, store_id: int, pagination: PaginationParams, *,
    q: str = "", status: str = "", kind: str = "",
    start: date | None = None, end: date | None = None,
    sort: str = "received", direction: str = "desc",
) -> dict[str, Any]:
    """One page of the store's files, newest first by default, in
    the ``api.Core.Pagination`` envelope plus ``summary``."""
    if status not in STATUSES:
        raise DeveloperQueryError(f"Unknown status {status!r}.")
    if kind not in KINDS:
        raise DeveloperQueryError(f"Unknown kind {kind!r}.")
    if sort not in SORTS:
        raise DeveloperQueryError(f"Unknown sort {sort!r}.")
    if direction not in ("asc", "desc"):
        raise DeveloperQueryError(f"Unknown direction {direction!r}.")
    if start and end and start > end:
        raise DeveloperQueryError("The start date is after the end date.")

    query = (
        db.query(PosJournalFile)
        .options(load_only(*_LIST_COLUMNS))
        .filter(PosJournalFile.store_id == store_id)
    )
    needle = q.strip()
    if needle:
        like = f"%{needle}%"
        query = query.filter(or_(
            PosJournalFile.filename.ilike(like),
            PosJournalFile.parse_error.ilike(like),
        ))
    if status == STATUS_NOT_IMPORTED:
        query = query.filter(PosJournalFile.parse_error != "")
    elif status == STATUS_IMPORTED:
        query = query.filter(PosJournalFile.parse_error == "")
    if kind == KIND_MOVEMENT:
        query = query.filter(PosJournalFile.event_kind == MOVEMENT_KIND)
    elif kind == KIND_JOURNAL:
        query = query.filter(
            PosJournalFile.event_kind != "",
            PosJournalFile.event_kind != MOVEMENT_KIND,
        )
    elif kind == KIND_UNKNOWN:
        query = query.filter(PosJournalFile.event_kind == "")
    if start is not None:
        query = query.filter(PosJournalFile.business_date >= start)
    if end is not None:
        query = query.filter(PosJournalFile.business_date <= end)
    column = SORTS[sort]
    query = query.order_by(
        column.desc() if direction == "desc" else column.asc(),
        PosJournalFile.id.desc(),
    )
    return paginate(
        query, pagination, adapter=file_row,
        extras={"summary": summary(db, store_id)},
    )


def _get(db: Session, store_id: int, file_id: int) -> PosJournalFile | None:
    return (
        db.query(PosJournalFile)
        .filter(
            PosJournalFile.id == file_id,
            PosJournalFile.store_id == store_id,
        )
        .first()
    )


def declared_encoding(raw: bytes) -> str:
    """The encoding the file's XML declaration names, when Python
    knows it; else UTF-8 (the XML default)."""
    match = _DECLARED.match(raw[:200])
    if match:
        name = match.group(1).decode("ascii", errors="ignore")
        try:
            return codecs.lookup(name).name
        except LookupError:
            pass
    return _DEFAULT_ENCODING


def raw_file(
    db: Session, store_id: int, file_id: int,
) -> tuple[str, bytes, str] | None:
    """(file name, the exact bytes Passport wrote, their encoding)
    for one of the store's files, or None."""
    f = _get(db, store_id, file_id)
    if f is None:
        return None
    raw = gzip.decompress(f.content_gz)
    return str(f.filename), raw, declared_encoding(raw)


def file_detail(
    db: Session, store_id: int, file_id: int,
) -> dict[str, Any] | None:
    f = _get(db, store_id, file_id)
    if f is None:
        return None
    raw = gzip.decompress(f.content_gz)
    encoding = declared_encoding(raw)
    shown = raw[:SHOW_LIMIT_BYTES]
    return {
        "file": file_row(f),
        "size_bytes": len(raw),
        "xml": shown.decode(encoding, errors="replace"),
        "encoding": encoding,
        "truncated": len(raw) > SHOW_LIMIT_BYTES,
        "line_count": raw.count(b"\n") + (0 if raw.endswith(b"\n") else 1),
    }


def safe_filename(name: str) -> str:
    """The file name for a Content-Disposition header: no quotes,
    slashes or line breaks reach the header."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("._") or "file"
    return cleaned[:120]


__all__ = [
    "DeveloperQueryError", "KINDS", "SHOW_LIMIT_BYTES", "STATUSES",
    "declared_encoding", "file_detail", "file_row", "is_developer",
    "list_files", "raw_file", "safe_filename", "store_name", "summary",
]
