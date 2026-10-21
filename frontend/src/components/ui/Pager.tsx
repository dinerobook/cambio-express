import type { ReactNode } from "react";

import { tokens } from "./tokens";
import { Button } from "./Button";
import { PAGE_SIZES, pageRange } from "../../lib/pagination";
import { Select } from "./Select";

/** Prev/next pagination footer — the one pager every list uses.
 *
 *  Pass ``total`` (the envelope's row count) and ``pageRows`` (rows
 *  on this page) and it reads "Showing 51–100 of 1,234", shown even
 *  on a single page so every list states how much it holds. Without
 *  them it falls back to "2 / 7". ``leading`` is for an optional
 *  left-aligned label (e.g. "Page total: $123.45"). */
export function Pager({
  page, totalPages, onPage, leading, total, pageRows, perPage, onPerPage,
}: {
  page: number;
  totalPages: number;
  onPage: (next: number) => void;
  /** Optional left-aligned content (e.g. "Page total: $123.45"). */
  leading?: ReactNode;
  /** Rows across every page (the envelope's ``total``). */
  total?: number;
  /** Rows on the current page. */
  pageRows?: number;
  /** With ``onPerPage``: shows the 25 / 50 / 100 rows-per-page picker. */
  perPage?: number;
  onPerPage?: (next: number) => void;
}) {
  const counted = total != null && pageRows != null && total > 0;
  // The picker only matters once a list is longer than the smallest page.
  const sizer = perPage != null && onPerPage != null
    && total != null && total > PAGE_SIZES[0];
  if (totalPages <= 1 && !leading && !counted) return null;
  const [first, last] = counted
    ? pageRange(page, totalPages, total, pageRows)
    : [0, 0];
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: leading || counted ? "space-between" : "flex-end",
        alignItems: "center",
        marginTop: "1rem",
        gap: "0.75rem 1rem",
      }}
    >
      {(leading || counted) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 1rem", alignItems: "center" }}>
          {counted && (
            <span style={{ color: tokens.textMuted, fontSize: "0.85rem" }}>
              Showing {first.toLocaleString()}–{last.toLocaleString()} of{" "}
              {total.toLocaleString()}
            </span>
          )}
          {leading}
        </div>
      )}
      {(totalPages > 1 || sizer) && (
        <nav aria-label="Pages" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
          {sizer && (
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", color: tokens.textMuted, fontSize: "0.85rem" }}>
              Rows
              <Select
                aria-label="Rows per page"
                value={perPage}
                onChange={(e) => onPerPage(Number(e.target.value))}
                style={{ width: "auto", padding: "0.3rem 0.5rem" }}
              >
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </label>
          )}
          {totalPages > 1 && (
            <>
              <Button
                tone="secondary"
                size="sm"
                onClick={() => onPage(page - 1)}
                disabled={page <= 1}
              >
                ← Previous
              </Button>
              <span style={{ color: tokens.textMuted, fontSize: "0.85rem" }}>
                {page} / {totalPages}
              </span>
              <Button
                tone="secondary"
                size="sm"
                onClick={() => onPage(page + 1)}
                disabled={page >= totalPages}
              >
                Next →
              </Button>
            </>
          )}
        </nav>
      )}
    </div>
  );
}
