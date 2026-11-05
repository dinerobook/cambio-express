import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCsv, csvCell, csvFilename, csvMoney, CsvTooLargeError,
  fetchAllPages, saveCsv,
} from "./csv";
import { setDisplayTimezone } from "./datetime";

// The table CSV export's file rules: numbers stay numbers, quoting
// per RFC 4180, formulas defused, every page fetched in order, and a
// refusal before the browser fetches a huge list.

describe("csvCell", () => {
  it("writes numbers and plain words as they are", () => {
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell("Maria")).toBe("Maria");
    expect(csvCell("1234.50")).toBe("1234.50");
  });

  it("leaves missing values and NaN as empty cells", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("Pérez, Juan")).toBe('"Pérez, Juan"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("defuses text a spreadsheet would run as a formula", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("\tx")).toBe("'\tx");
  });

  it("keeps signed numbers as numbers", () => {
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell("+3")).toBe("+3");
    expect(csvCell(-12.5)).toBe("-12.5");
  });
});

describe("buildCsv", () => {
  it("writes a header row and CRLF line ends", () => {
    expect(buildCsv(["Name", "Amount"], [["Ana", "10.00"], ["Luis", null]]))
      .toBe("Name,Amount\r\nAna,10.00\r\nLuis,\r\n");
  });

  it("writes only the header for an empty list", () => {
    expect(buildCsv(["A"], [])).toBe("A\r\n");
  });
});

describe("csvMoney", () => {
  it("is two decimals with no symbol or separator", () => {
    expect(csvMoney(1234.5)).toBe("1234.50");
    expect(csvMoney("-3")).toBe("-3.00");
    expect(csvMoney(0)).toBe("0.00");
  });

  it("is empty for a missing amount, never 0", () => {
    expect(csvMoney(null)).toBe("");
    expect(csvMoney(undefined)).toBe("");
    expect(csvMoney("")).toBe("");
    expect(csvMoney("abc")).toBe("");
  });
});

describe("csvFilename", () => {
  afterEach(() => setDisplayTimezone(null));

  it("dates the file by the store's day, not the UTC day", () => {
    setDisplayTimezone("America/Chicago");
    // 03:00 UTC on Nov 6 is still Nov 5 in Chicago.
    expect(csvFilename("transfers", new Date("2026-11-06T03:00:00Z")))
      .toBe("transfers-2026-11-05.csv");
  });
});

describe("saveCsv", () => {
  it("saves UTF-8 with a byte-order mark under the given name", async () => {
    const created: Blob[] = [];
    const url = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      created.push(b as Blob);
      return "blob:x";
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    let name = "";
    click.mockImplementation(function (this: HTMLAnchorElement) { name = this.download; });
    saveCsv("A\r\n", "list-2026-11-05.csv");
    expect(name).toBe("list-2026-11-05.csv");
    expect(created[0].type).toBe("text/csv;charset=utf-8");
    const bytes = new Uint8Array(await created[0].arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    url.mockRestore();
    click.mockRestore();
  });
});

describe("fetchAllPages", () => {
  const pageOf = (p: number, pages: number, total: number) => ({
    rows: [`r${p}a`, `r${p}b`], total, total_pages: pages,
  });

  it("returns every page's rows in page order", async () => {
    const fetchPage = vi.fn((p: number, n: number) => Promise.resolve(pageOf(p, 6, 6 * n)));
    const rows = await fetchAllPages(fetchPage, { perPage: 2 });
    expect(rows).toEqual([
      "r1a", "r1b", "r2a", "r2b", "r3a", "r3b",
      "r4a", "r4b", "r5a", "r5b", "r6a", "r6b",
    ]);
    expect(fetchPage).toHaveBeenCalledTimes(6);
    expect(fetchPage.mock.calls.every(([, n]) => n === 2)).toBe(true);
  });

  it("asks once for a one-page list", async () => {
    const fetchPage = vi.fn(() => Promise.resolve(pageOf(1, 1, 2)));
    expect(await fetchAllPages(fetchPage)).toEqual(["r1a", "r1b"]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("refuses a list over the limit after the first page only", async () => {
    const fetchPage = vi.fn(() => Promise.resolve(pageOf(1, 500, 50_000)));
    await expect(fetchAllPages(fetchPage, { maxRows: 10_000 }))
      .rejects.toBeInstanceOf(CsvTooLargeError);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("passes a failed page on to the caller", async () => {
    const fetchPage = vi.fn((p: number) => (
      p === 3 ? Promise.reject(new Error("boom")) : Promise.resolve(pageOf(p, 4, 8))
    ));
    await expect(fetchAllPages(fetchPage, { perPage: 2 })).rejects.toThrow("boom");
  });
});
