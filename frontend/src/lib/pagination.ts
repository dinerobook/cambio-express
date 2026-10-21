// Pagination helpers shared by the kit's <Pager> / <DataTable> and
// useUrlFilterState.

/** The rows-per-page choices every paged list offers. */
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;

const STORAGE_PREFIX = "db.page_size.";

/** A list's remembered rows-per-page, or the default. Storage can be
 *  missing or blocked (private window), so every read is guarded. */
export function readPageSize(key: string): number {
  try {
    const n = Number(window.localStorage.getItem(STORAGE_PREFIX + key));
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

export function writePageSize(key: string, n: number): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, String(n));
  } catch {
    // Storage blocked — the choice lasts for this visit only.
  }
}

/** Which rows of ``total`` this page holds, as 1-based ``[first, last]``.
 *  Works from the rows actually on screen so it needs no ``per_page``
 *  from the server: every page but the last is full, so a full page's
 *  length IS the page size, and the last page ends at ``total``. */
export function pageRange(
  page: number, totalPages: number, total: number, pageRows: number,
): [number, number] {
  if (total <= 0 || pageRows <= 0) return [0, 0];
  const first = page >= totalPages
    ? total - pageRows + 1
    : (page - 1) * pageRows + 1;
  return [Math.max(1, first), Math.min(total, first + pageRows - 1)];
}

/** One page of a list the server sends whole (a store's employees):
 *  the same envelope a paged endpoint returns, so the page can hand
 *  it straight to ``<DataTable page>``. An out-of-range page clamps. */
export function pageOf<T>(rows: readonly T[], page: number, perPage: number): {
  rows: T[]; page: number; totalPages: number; total: number;
} {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const at = Math.min(Math.max(1, page), totalPages);
  return {
    rows: rows.slice((at - 1) * perPage, at * perPage),
    page: at, totalPages, total,
  };
}

/** Sort a whole list in the browser by one of ``keys`` — text by
 *  locale (case-insensitive), numbers numerically. An unknown key
 *  leaves the order as given. Never mutates ``rows``. */
export function sortRows<T>(
  rows: readonly T[],
  keys: Record<string, (row: T) => string | number>,
  key: string | undefined,
  direction: "asc" | "desc" = "asc",
): T[] {
  const read = key ? keys[key] : undefined;
  if (!read) return [...rows];
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = read(a);
    const y = read(b);
    const cmp = typeof x === "number" && typeof y === "number"
      ? x - y
      : String(x).localeCompare(String(y), undefined, { sensitivity: "base" });
    return cmp * sign;
  });
}
