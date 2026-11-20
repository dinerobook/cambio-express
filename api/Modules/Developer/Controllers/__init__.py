"""Developer — Controllers (FastAPI router).

Mounts at ``/api/v2/developer/*`` (module docstring: who may call):

  GET  /developer/files              the store's import files (paged)
  GET  /developer/files/{id}         one file: details + its XML
  GET  /developer/files/{id}/raw     the file itself, as plain text
                                     (``?download=1``: the exact
                                     bytes, as an attachment)

The raw route never answers as XML: a file from a register is
untrusted input, and served as XML a browser would render (and
could run) it. As ``text/plain`` with ``nosniff`` (on every
response, invariant 22) it is only ever text.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from sqlalchemy.orm import Session

from api.Core.Clock import parse_iso_day
from api.Core.Database import get_db
from api.Core.Pagination import PaginationParams
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services.principal import resolve_store_scope
from api.Modules.Developer.Requests import (
    DevFileDetailResponse, DevFileListResponse,
)
from api.Modules.Developer.Services import (
    DeveloperQueryError, file_detail, is_developer, list_files, raw_file,
    safe_filename, store_name,
)

router = APIRouter(prefix="/developer", tags=["developer"])

_REFUSED = (
    "Only a superadmin signed in as this store can open the Developer tab."
)


def _developer_store(db: Session, claims: dict[str, Any]) -> int:
    """The token's own store, for a developer; 403 for anyone else."""
    if not is_developer(db, claims):
        raise HTTPException(status_code=403, detail=_REFUSED)
    return resolve_store_scope(claims)


@router.get("/files", response_model=DevFileListResponse)
def list_files_route(
    q: str = Query("", max_length=120),
    status: str = Query("", max_length=20),
    kind: str = Query("", max_length=20),
    start: str = Query("", max_length=10, description="YYYY-MM-DD"),
    end: str = Query("", max_length=10, description="YYYY-MM-DD"),
    sort: str = Query("received", max_length=20),
    direction: str = Query("desc", max_length=4),
    pagination: PaginationParams = Depends(),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DevFileListResponse:
    """Every Passport file the store's register sent, newest first,
    with why one did not import. ``status`` is ``not_imported`` /
    ``imported`` / "" (all); ``kind`` is ``journal`` / ``movement``
    / ``unknown`` / "" (all); the dates filter on business date."""
    sid = _developer_store(db, claims)
    start_d = parse_iso_day(start, field="start") if start else None
    end_d = parse_iso_day(end, field="end") if end else None
    try:
        result = list_files(
            db, sid, pagination, q=q, status=status, kind=kind,
            start=start_d, end=end_d, sort=sort, direction=direction,
        )
    except DeveloperQueryError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return DevFileListResponse(
        **result, store_id=sid, store_name=store_name(db, sid),
    )


@router.get("/files/{file_id}", response_model=DevFileDetailResponse)
def file_detail_route(
    file_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> DevFileDetailResponse:
    """One file: what it is, why it did or did not import, and its
    XML as Passport wrote it (cut at 2 MB; the raw route has all)."""
    sid = _developer_store(db, claims)
    detail = file_detail(db, sid, file_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="File not found")
    return DevFileDetailResponse(
        **detail, store_id=sid, store_name=store_name(db, sid),
    )


@router.get("/files/{file_id}/raw", response_class=Response)
def raw_file_route(
    file_id: int = Path(..., ge=1),
    download: bool = Query(False),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> Response:
    """The file itself. Plain text in the browser (readable as is,
    never rendered as XML); ``?download=1`` sends the exact bytes
    as an attachment under the file's own name."""
    sid = _developer_store(db, claims)
    found = raw_file(db, sid, file_id)
    if found is None:
        raise HTTPException(status_code=404, detail="File not found")
    name, raw, encoding = found
    filename = safe_filename(name)
    if download:
        return Response(
            content=raw,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )
    text = raw.decode(encoding, errors="replace")
    return Response(
        content=text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )
