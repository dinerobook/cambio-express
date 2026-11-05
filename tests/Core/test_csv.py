"""Tests for the shared CSV-construction helper."""
from api.Core.Csv import build_csv


def test_build_csv_with_headers_and_rows():
    result = build_csv(
        ["A", "B", "C"],
        [[1, 2, 3], [4, 5, 6]],
    )
    lines = result.strip().split("\r\n")
    assert lines[0] == "A,B,C"
    assert lines[1] == "1,2,3"
    assert lines[2] == "4,5,6"


def test_build_csv_empty_rows_returns_header_only():
    result = build_csv(["A", "B"], [])
    lines = result.strip().split("\r\n")
    assert lines == ["A,B"]


def test_build_csv_accepts_generator():
    rows = ((i, i * 2) for i in range(3))
    result = build_csv(["x", "y"], rows)
    lines = result.strip().split("\r\n")
    assert lines == ["x,y", "0,0", "1,2", "2,4"]


def test_build_csv_handles_string_values_with_commas():
    """csv.writer quotes strings containing commas."""
    result = build_csv(
        ["name", "address"],
        [["Doe, Jane", "1 Main St, Apt 2"]],
    )
    lines = result.strip().split("\r\n")
    assert lines[1] == '"Doe, Jane","1 Main St, Apt 2"'


def test_build_csv_handles_mixed_types():
    """Numbers, strings, None, floats all get serialized."""
    result = build_csv(
        ["a", "b", "c", "d"],
        [["text", 42, 3.14, None]],
    )
    lines = result.strip().split("\r\n")
    assert lines[1] == "text,42,3.14,"


def test_build_csv_preserves_row_order():
    result = build_csv(
        ["i"],
        [[i] for i in [3, 1, 2]],
    )
    lines = result.strip().split("\r\n")
    assert lines == ["i", "3", "1", "2"]


def test_build_csv_with_unicode():
    result = build_csv(
        ["name"],
        [["López"], ["日本語"], ["café"]],
    )
    assert "López" in result
    assert "日本語" in result
    assert "café" in result


# ── Formula defusing (CSV injection) ────────────────────────────
#
# A cell a spreadsheet would run as a formula is written as text
# with a leading apostrophe; numbers and signed amounts stay as they
# are so a column still adds up. The SPA's table export applies the
# same rule (frontend/src/lib/csv.ts).

from api.Core.Csv import safe_cell, safe_row  # noqa: E402


def test_safe_cell_defuses_formula_starts():
    assert safe_cell('=HYPERLINK("http://x","y")') == '\'=HYPERLINK("http://x","y")'
    assert safe_cell("+1 555 0100") == "'+1 555 0100"
    assert safe_cell("@SUM(A1)") == "'@SUM(A1)"
    assert safe_cell("-cmd") == "'-cmd"
    assert safe_cell("\tx") == "'\tx"
    assert safe_cell("\rx") == "'\rx"


def test_safe_cell_keeps_numbers_and_plain_text():
    assert safe_cell("-12.50") == "-12.50"
    assert safe_cell("+3") == "+3"
    assert safe_cell(-12.5) == -12.5
    assert safe_cell(0) == 0
    assert safe_cell(None) is None
    assert safe_cell("Maria Lopez") == "Maria Lopez"
    assert safe_cell("") == ""


def test_safe_row_applies_to_every_cell():
    assert safe_row(["=1+1", 2, "ok"]) == ["'=1+1", 2, "ok"]


def test_build_csv_defuses_formulas_in_rows_and_headers():
    result = build_csv(["=evil"], [["=2+2"], ["-5.00"], ["@x"]])
    assert result.split("\r\n")[:4] == ["'=evil", "'=2+2", "-5.00", "'@x"]
