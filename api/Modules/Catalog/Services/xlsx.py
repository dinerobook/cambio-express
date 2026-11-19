"""Read the first sheet of an .xlsx upload, safely.

An .xlsx file is a ZIP of XML parts. The app ships no spreadsheet
library, and the import only needs cell text, so this reads the parts
itself:

* every XML part goes through ``defusedxml`` (no entity expansion, no
  external entities, no DTDs);
* every part is streamed through a byte cap, so a "zip bomb" (a tiny
  file that inflates to gigabytes) stops at ``MAX_PART_BYTES`` whatever
  size the ZIP directory claims;
* rows are parsed one at a time (``iterparse`` + ``clear()``), and the
  sheet stops at ``max_rows``.

A cell comes back as its text plus whether Excel stored it as a
number. That matters for scan codes: a code stored as a number has
already lost its leading zeros.
"""
from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import IO, Iterator
from xml.etree.ElementTree import Element

from defusedxml.ElementTree import fromstring, iterparse

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_M = f"{{{MAIN_NS}}}"

# The largest one XML part may inflate to. A 20,000-item price book's
# sheet is ~10 MB; this leaves room for ten times that.
MAX_PART_BYTES = 120 * 1024 * 1024
MAX_COLUMNS = 64
_REF = re.compile(r"([A-Z]{1,3})")


class XlsxError(ValueError):
    """The upload is not a readable .xlsx (message is shown to the user)."""


@dataclass(frozen=True)
class Cell:
    text: str
    numeric: bool = False


EMPTY = Cell("")


class _Capped(io.RawIOBase):
    """A read-only stream that fails once more than ``limit`` bytes
    have come through."""

    def __init__(self, inner: IO[bytes], limit: int, part: str) -> None:
        self._inner, self._left, self._part = inner, limit, part

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: "bytearray | memoryview") -> int:  # type: ignore[override]
        view = memoryview(buffer)
        data = self._inner.read(min(len(view), self._left + 1))
        if len(data) > self._left:
            raise XlsxError("The spreadsheet is too large to read.")
        self._left -= len(data)
        view[:len(data)] = data
        return len(data)


def _open_part(z: zipfile.ZipFile, name: str) -> IO[bytes]:
    try:
        info = z.getinfo(name)
    except KeyError:
        raise XlsxError("The file is not a complete .xlsx spreadsheet.")
    if info.file_size > MAX_PART_BYTES:
        raise XlsxError("The spreadsheet is too large to read.")
    return io.BufferedReader(_Capped(z.open(info), MAX_PART_BYTES, name))


def _small_part(z: zipfile.ZipFile, name: str) -> bytes:
    with _open_part(z, name) as f:
        return f.read()


def _column(ref: str | None) -> int | None:
    if not ref:
        return None
    m = _REF.match(ref)
    if not m:
        return None
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _number_text(raw: str) -> str:
    """Excel's stored number as plain text: "4.9000000634E10" →
    "49000000634", "12.50" stays "12.50"."""
    try:
        value = Decimal(raw)
    except InvalidOperation:
        return raw
    if not value.is_finite():
        return ""
    if value == value.to_integral_value():
        return str(int(value))
    return raw


def _first_sheet_part(z: zipfile.ZipFile) -> str:
    workbook = fromstring(_small_part(z, "xl/workbook.xml"))
    rels = fromstring(_small_part(z, "xl/_rels/workbook.xml.rels"))
    targets = {r.get("Id"): r.get("Target") or "" for r in rels}
    sheets = workbook.find(f"{_M}sheets")
    first = sheets[0] if sheets is not None and len(sheets) else None
    if first is None:
        raise XlsxError("The spreadsheet has no sheets.")
    target = targets.get(first.get(f"{{{REL_NS}}}id"), "")
    if not target:
        raise XlsxError("The file is not a complete .xlsx spreadsheet.")
    target = target.lstrip("/")
    return target if target.startswith("xl/") else f"xl/{target}"


def _string_text(el: Element | None) -> str:
    """The text of a string item (<si> / <is>): plain <t>, or rich-text
    runs <r><t>. Phonetic hints (<rPh>) are not part of the text."""
    if el is None:
        return ""
    parts: list[str] = []
    for child in el:
        if child.tag == f"{_M}t":
            parts.append(child.text or "")
        elif child.tag == f"{_M}r":
            parts.extend(t.text or "" for t in child.iter(f"{_M}t"))
    return "".join(parts)


def _shared_strings(z: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    out: list[str] = []
    with _open_part(z, "xl/sharedStrings.xml") as f:
        for _event, el in iterparse(f, events=("end",)):
            if el.tag == f"{_M}si":
                out.append(_string_text(el))
                el.clear()
    return out


def _cell(el: Element, shared: list[str]) -> Cell:
    typ = el.get("t")
    value = el.findtext(f"{_M}v")
    if typ == "s":
        try:
            return Cell(shared[int(value or "")])
        except (ValueError, IndexError):
            return EMPTY
    if typ == "inlineStr":
        return Cell(_string_text(el.find(f"{_M}is")))
    if typ in ("str", "b"):
        return Cell(value or "")
    if typ == "e" or value is None:
        return EMPTY
    return Cell(_number_text(value), numeric=True)


def iter_first_sheet(data: bytes, *, max_rows: int) -> Iterator[list[Cell]]:
    """Each row of the first sheet as a list of cells (gaps filled with
    empty cells). Raises ``XlsxError`` on anything unreadable, or after
    ``max_rows`` rows."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise XlsxError("The file is not an .xlsx spreadsheet.")
    with z:
        try:
            shared = _shared_strings(z)
            part = _first_sheet_part(z)
            count = 0
            with _open_part(z, part) as f:
                cells: dict[int, Cell] = {}
                for _event, el in iterparse(f, events=("end",)):
                    if el.tag == f"{_M}c":
                        col = _column(el.get("r"))
                        if col is None:
                            col = (max(cells) + 1) if cells else 0
                        if col < MAX_COLUMNS:
                            cells[col] = _cell(el, shared)
                    elif el.tag == f"{_M}row":
                        count += 1
                        if count > max_rows:
                            raise XlsxError(
                                f"The spreadsheet has more than {max_rows:,} rows."
                            )
                        width = (max(cells) + 1) if cells else 0
                        yield [cells.get(i, EMPTY) for i in range(width)]
                        cells = {}
                        el.clear()
        except XlsxError:
            raise
        except (zipfile.BadZipFile, EOFError, OSError):
            raise XlsxError("The file is damaged and could not be read.")
        except Exception as exc:  # defusedxml / ParseError / bad XML
            raise XlsxError("The spreadsheet could not be read.") from exc


__all__ = ["Cell", "MAX_PART_BYTES", "XlsxError", "iter_first_sheet"]
