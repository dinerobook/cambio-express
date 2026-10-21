import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { Pager } from "./Pager";
import { Table } from "./Table";
import { TableStates } from "./TableStates";
import { tdStyle, thStyle } from "./tokens";
import styles from "./DataTable.module.css";

/** One column of a ``<DataTable>``. ``render`` draws the cell;
 *  ``align: "right"`` is for money and counts. ``sortKey`` makes the
 *  header a sort button when the table is given ``sort``. */
export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
  sortKey?: string;
  /** Direction a first click sorts this column in (dates and money
   *  read best newest / largest first). Defaults to "asc". */
  sortFirst?: "asc" | "desc";
  /** Label shown beside the value in the phone card view when
   *  ``header`` is not plain text. Empty hides the label. */
  label?: string;
}

export interface DataTableSort {
  key: string;
  direction: "asc" | "desc";
  /** Called with the column and the direction it should now sort
   *  in: the active column flips, another starts at its
   *  ``sortFirst``. ``useUrlFilterState({ defaultSort })`` returns
   *  this whole shape. */
  onSort: (key: string, direction: "asc" | "desc") => void;
}

/** The page slice a paged list hands its pager — the
 *  ``api.Core.Pagination`` envelope's fields. */
export interface DataTablePage {
  page: number;
  totalPages: number;
  total: number;
  onPage: (next: number) => void;
  /** Left-aligned extra beside the row count (page totals). */
  leading?: ReactNode;
  /** With ``onPerPage``: the 25 / 50 / 100 rows-per-page picker. */
  perPage?: number;
  onPerPage?: (next: number) => void;
}

/**
 * The shared list table: header cells, row cells, loading skeleton,
 * error with retry, empty state and the pager, in one place so every
 * list in the app looks and behaves the same.
 *
 * - Columns are declared once; the header and every row read them.
 * - ``onRowClick`` makes each row open by mouse AND keyboard
 *   (Enter / Space), announced with ``rowLabel``.
 * - ``expandedRow`` opens a full-width panel under a row (a ticket's
 *   conversation); the page decides which row is open, the row
 *   announces it with ``aria-expanded``.
 * - ``page`` adds the shared ``<Pager>`` with "Showing a–b of N"
 *   and, given ``perPage`` + ``onPerPage``, the rows-per-page picker.
 * - The header stays pinned while the list scrolls (the table scrolls
 *   inside a box at most ~70% of the screen tall).
 * - Under phone width (36rem) each row becomes a card of
 *   "label  value" lines, so nothing scrolls sideways.
 *
 * Small tables inside forms (daily-book boxes, receipts, the
 * permission grid) keep the bare ``<Table>``; this is for lists.
 */
export interface DataTableProps<T> {
  columns: DataColumn<T>[];
  rows: T[] | undefined;
  /** Stable key per row; the index is there for feeds with no id. */
  rowKey: (row: T, index: number) => string | number;
  onRowClick?: (row: T) => void;
  /** Accessible name for a clickable row ("Open transfer 123"). */
  rowLabel?: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  errorMessage?: string;
  emptyTitle: string;
  emptyBody?: ReactNode;
  page?: DataTablePage;
  sort?: DataTableSort;
  /** Content for a full-width panel under the row, or null when the
   *  row is closed. Pair with ``onRowClick`` to toggle it. */
  expandedRow?: (row: T) => ReactNode;
  /** Optional ``<tfoot>`` content (totals rows). */
  footer?: ReactNode;
}

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, rowLabel, rowClassName,
  isLoading = false, isError = false, error, onRetry,
  errorMessage, emptyTitle, emptyBody, page, sort, expandedRow, footer,
}: DataTableProps<T>) {
  const list = rows ?? [];
  const states = (
    <TableStates
      isLoading={isLoading}
      isError={isError}
      error={error}
      isEmpty={!isLoading && !isError && list.length === 0}
      onRetry={onRetry ?? (() => {})}
      errorMessage={errorMessage}
      emptyTitle={emptyTitle}
      emptyBody={emptyBody}
      cols={Math.min(columns.length, 6)}
    />
  );
  if (isLoading || isError || list.length === 0) return states;

  return (
    <div className={styles.root}>
      <Table>
        <thead>
          <tr>
            {columns.map((c) => (
              <HeaderCell key={c.key} column={c} sort={sort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((row, index) => {
            const extra = rowClassName?.(row);
            const clickable = Boolean(onRowClick);
            const open = () => onRowClick?.(row);
            const onClick = (e: MouseEvent<HTMLTableRowElement>) => {
              // A button, link or field inside the row does its own
              // job; only a click on the row itself opens it.
              if (insideControl(e.target, e.currentTarget)) return;
              open();
            };
            const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            };
            const panel = expandedRow?.(row);
            return (
              <Fragment key={rowKey(row, index)}>
              <tr
                className={[clickable ? styles.clickable : "", extra ?? ""].join(" ").trim() || undefined}
                {...(clickable ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-label": rowLabel?.(row),
                  ...(expandedRow ? { "aria-expanded": panel != null } : {}),
                  onClick,
                  onKeyDown,
                } : {})}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    data-label={cardLabel(c)}
                    style={c.align === "right" ? { ...tdStyle, textAlign: "right" } : tdStyle}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
              {panel != null && (
                <tr className={styles.panelRow}>
                  <td colSpan={columns.length} className={styles.panel}>{panel}</td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </Table>
      {page && (
        <Pager
          page={page.page}
          totalPages={page.totalPages}
          onPage={page.onPage}
          total={page.total}
          pageRows={list.length}
          leading={page.leading}
          perPage={page.perPage}
          onPerPage={page.onPerPage}
        />
      )}
    </div>
  );
}

const CONTROLS = "a, button, input, select, textarea, label, [role='menu'], [role='dialog']";

function insideControl(target: EventTarget, row: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  // React bubbles events out of portals (RowActions' phone sheet,
  // dialogs): a click that is not in the row's own DOM is not a
  // click on the row.
  if (!row.contains(target)) return true;
  const hit = target.closest(CONTROLS);
  return hit != null && hit !== row && row.contains(hit);
}

function cardLabel<T>(c: DataColumn<T>): string {
  if (c.label != null) return c.label;
  return typeof c.header === "string" ? c.header : "";
}

function HeaderCell<T>({
  column, sort,
}: { column: DataColumn<T>; sort?: DataTableSort }) {
  const align = column.align === "right" ? "right" : "left";
  if (!sort || !column.sortKey) {
    return (
      <th scope="col" style={{ ...thStyle, textAlign: align }}>
        {column.header}
      </th>
    );
  }
  const active = sort.key === column.sortKey;
  const ariaSort = active
    ? sort.direction === "asc" ? "ascending" : "descending"
    : "none";
  const sortKey = column.sortKey;
  return (
    <th scope="col" aria-sort={ariaSort} style={{ ...thStyle, textAlign: align, padding: 0 }}>
      <button
        type="button"
        className={styles.sortBtn}
        style={{ justifyContent: align === "right" ? "flex-end" : "flex-start" }}
        onClick={() => sort.onSort(
          sortKey,
          active
            ? sort.direction === "asc" ? "desc" : "asc"
            : column.sortFirst ?? "asc",
        )}
      >
        {column.header}
        <span aria-hidden="true" className={active ? styles.arrowActive : styles.arrow}>
          {active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}
