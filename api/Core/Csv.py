"""Tiny CSV-construction helper for the parts of the codebase
that produce CSV strings/responses but don't fit the
``Reports/Controllers/csv_export.py`` registry (which is bound to
the date-range report pattern).

Every CSV the server writes goes through ``safe_cell`` (here, or
``safe_row`` in the report registry), so no exported cell runs as a
spreadsheet formula.

Currently used by:
  - ``Admin/Services/tax_pack.py`` — multi-CSV tax-prep ZIP
  - Other ad-hoc CSV builders that needed only the StringIO ↔
    csv.writer ↔ headers+rows mechanics

If a caller needs the report-registry pattern (period filter +
auto-attachment response), use
``Reports/Controllers/csv_export.py`` instead.
"""
from __future__ import annotations

import csv
import io
import re
from typing import Iterable, Sequence

# Text a spreadsheet would run as a formula: a cell starting with
# = + - @, a tab or a carriage return (OWASP "CSV injection"). A
# customer or payee named "=HYPERLINK(...)" would otherwise turn into a
# live link or command when the owner opens the file in Excel.
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
# Signed numbers ("-12.50") are data, not formulas: leave them alone
# so a spreadsheet still adds the column up.
_PLAIN_NUMBER = re.compile(r"^[-+]?(\d+(\.\d*)?|\.\d+)$")


def safe_cell(value: object) -> object:
    """``value`` as a CSV cell that cannot run as a formula: text that
    starts like one gets a leading apostrophe (shown as text, not
    evaluated). Numbers, ``None`` and ordinary text pass unchanged.
    The SPA's table export applies the same rule (``lib/csv.ts``)."""
    if isinstance(value, str) and value.startswith(_FORMULA_START) \
            and not _PLAIN_NUMBER.match(value):
        return "'" + value
    return value


def safe_row(row: Iterable[object]) -> list[object]:
    """Every cell of ``row`` through ``safe_cell``."""
    return [safe_cell(v) for v in row]


def build_csv(
    headers: Sequence[str],
    rows: Iterable[Sequence[object]],
) -> str:
    """Render ``headers`` + ``rows`` as a CSV string. Empty rows
    iterable produces a header-only CSV. Each row's values are
    passed through csv.writer's default formatting (which calls
    ``str()`` on each value), after ``safe_cell`` defuses any text
    that would run as a spreadsheet formula."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(safe_row(headers))
    for row in rows:
        w.writerow(safe_row(row))
    return buf.getvalue()
