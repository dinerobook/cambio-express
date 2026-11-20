"""Developer — response schemas (every route is a GET; no bodies)."""
from pydantic import BaseModel


class DevFileRow(BaseModel):
    id: int
    filename: str
    # "journal" (a register event), "movement" (a period report) or
    # "unknown" (a file nothing could read).
    kind: str
    # The event the file holds (sale, refund, void, other,
    # financial), "movement", or "" when it could not be read.
    event_kind: str
    business_date: str | None
    received_at: str | None
    imported: bool
    # Why it did not import ("" when it did).
    reason: str


class DevFileSummary(BaseModel):
    """The store's files as a whole, whatever the filters."""

    files: int
    not_imported: int
    last_received_at: str | None


class DevFileListResponse(BaseModel):
    rows: list[DevFileRow]
    total: int
    page: int
    total_pages: int
    summary: DevFileSummary
    store_id: int
    store_name: str


class DevFileDetailResponse(BaseModel):
    file: DevFileRow
    store_id: int
    store_name: str
    size_bytes: int
    # The file's text as Passport wrote it (decoded with the
    # encoding its XML declaration names), cut at
    # ``SHOW_LIMIT_BYTES`` — the raw route always has all of it.
    xml: str
    encoding: str
    truncated: bool
    line_count: int
