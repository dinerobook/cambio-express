// CSV built in the browser — the shared table's "Export CSV"
// (UI-STANDARDS §7 "Export"). The server's own CSV downloads (report
// CSVs, Data export) follow the same cell rules in `api/Core/Csv.py`.
//
// Rules every exported file keeps:
//   • Numbers stay numbers: money is `1234.50`, never "$1,234.50", so
//     a spreadsheet can add a column up.
//   • Dates are the store's wall clock, `2026-10-09 14:05`
//     (`csvTimestamp` / `csvDate` in lib/datetime).
//   • A cell a spreadsheet would run as a formula (text starting with
//     = + - @, a tab or a carriage return) is written with a leading
//     apostrophe, so a customer named "=HYPERLINK(…)" stays text.
//     Plain numbers ("-12.50") are left alone.
//   • UTF-8 with a byte-order mark, so Excel shows "Pérez" and "Envíos"
//     instead of mojibake; CRLF line ends (RFC 4180).

import { saveBlob } from "./api";
import { todayIso } from "./datetime";

export type CsvValue = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;

/** One cell, escaped for CSV and defused for spreadsheets. */
export function csvCell(value: CsvValue): string {
  if (value == null) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  let s = value;
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A header row and data rows as CSV text (CRLF line ends). */
export function buildCsv(headers: string[], rows: CsvValue[][]): string {
  return [headers, ...rows]
    .map((r) => r.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
}

/** Money for a CSV cell: two decimals, no symbol, no thousands
 *  separator. Missing is an empty cell, not 0. */
export function csvMoney(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

/** ``transfers`` → ``transfers-2026-11-05.csv`` (the store's day). */
export function csvFilename(base: string, now: Date = new Date()): string {
  return `${base}-${todayIso(now)}.csv`;
}

/** Hand CSV text to the person as a download. */
export function saveCsv(text: string, filename: string): void {
  saveBlob(
    new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }),
    filename,
  );
}

/** The page a paged list endpoint answers (the `api.Core.Pagination`
 *  envelope). Only the fields an export reads. */
export interface CsvPage<T> {
  rows?: T[];
  total?: number;
  total_pages: number;
}

/** Rows one export may hold. Past this the person narrows the list
 *  first: the export is built in the browser, and a file this big is
 *  a backup, which Settings → Data export already gives. */
export const CSV_MAX_ROWS = 10_000;
/** Rows asked for per request: every list's pager offers 100, so
 *  every list endpoint takes it. */
export const CSV_PAGE_SIZE = 100;
const PARALLEL = 4;

/** Thrown when the list holds more than ``CSV_MAX_ROWS`` rows. */
export class CsvTooLargeError extends Error {
  readonly total: number;

  constructor(total: number) {
    super(`CSV export too large: ${total} rows`);
    this.name = "CsvTooLargeError";
    this.total = total;
  }
}

/** Every row of a paged list, in the list's own order: page 1 first
 *  (it says how many pages there are), then the rest a few at a time.
 *  Refuses before fetching the rest when the list is too large. */
export async function fetchAllPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<CsvPage<T>>,
  { perPage = CSV_PAGE_SIZE, maxRows = CSV_MAX_ROWS } = {},
): Promise<T[]> {
  const first = await fetchPage(1, perPage);
  const pages = Math.max(1, first.total_pages);
  const total = first.total ?? pages * perPage;
  if (total > maxRows) throw new CsvTooLargeError(total);
  const rest: T[][] = new Array(pages - 1);
  for (let start = 2; start <= pages; start += PARALLEL) {
    const batch = [];
    for (let p = start; p < start + PARALLEL && p <= pages; p += 1) {
      batch.push(fetchPage(p, perPage).then((r) => { rest[p - 2] = r.rows ?? []; }));
    }
    await Promise.all(batch);
  }
  return [first.rows ?? [], ...rest].flat();
}
