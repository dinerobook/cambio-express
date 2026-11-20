"""Build a minimal .xlsx in memory for import tests (one sheet).

Text cells are inline strings; ints / floats are number cells (the
first column too when ``numeric_first`` is true, the way Excel stores
a scan code or a register number typed as a number).
"""
import io
import zipfile
from xml.sax.saxutils import escape


def _col(i):
    out = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        out = chr(65 + r) + out
    return out


def make_xlsx(rows, *, numeric_first=False, sheet_xml=None, sheet_name="Sheet1"):
    def cell(ref, value, as_number):
        if value is None or value == "":
            return ""
        if as_number:
            return f'<c r="{ref}"><v>{value}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'

    body = []
    for r, row in enumerate(rows, start=1):
        cells = "".join(
            cell(
                f"{_col(c)}{r}", v,
                isinstance(v, (int, float)) and not isinstance(v, bool)
                and (c != 0 or numeric_first),
            )
            for c, v in enumerate(row)
        )
        body.append(f'<row r="{r}">{cells}</row>')
    sheet = sheet_xml or (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(body)}</sheetData></worksheet>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr(
            "xl/workbook.xml",
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets><sheet name="{escape(sheet_name)}" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>'
            '</Relationships>',
        )
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()
