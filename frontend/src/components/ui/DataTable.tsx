import {
  Fragment, useState, type KeyboardEvent, type MouseEvent, type ReactNode,
} from "react";

import { canDo } from "../../lib/access";
import {
  buildCsv, csvFilename, CsvTooLargeError, CSV_MAX_ROWS, fetchAllPages,
  saveCsv, type CsvPage, type CsvValue,
} from "../../lib/csv";
import { cardLabel, exportTable } from "./dataTableCsv";
import { apiErrorMessage } from "../../lib/api";
import { fmtNumber } from "../../lib/formatters";
import { useT } from "../../i18n";
import { Button } from "./Button";
import { Pager } from "./Pager";
import { Table } from "./Table";
import { TableStates } from "./TableStates";
import { useToast } from "./Toast";
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
  /** The cell's value in the CSV export, as data: a number or
   *  ``csvMoney(...)`` for money, ``csvTimestamp`` / ``csvDate`` for
   *  dates, plain words for the rest. A column without it (actions,
   *  checkboxes) is left out of the file. */
  csv?: (row: T) => CsvValue;
  /** CSV column name when ``header`` is not plain text (falls back
   *  to ``label``). */
  csvHeader?: string;
}

/** A column that exists only in the CSV file. */
export interface CsvColumn<T> {
  header: string;
  csv: (row: T) => CsvValue;
}

/** Opt-in "Export CSV" for a list (UI-STANDARDS §7 "Export"). The
 *  file holds every row the list's current search, filters and sort
 *  match — not only the page on screen — with the columns that have
 *  a ``csv`` value, headed in the person's language. */
export interface DataTableExport<T> {
  /** File name stem: "transfers" saves ``transfers-2026-11-05.csv``
   *  (the store's day). */
  filename: string;
  /** One page of the SAME list the table shows, with the page's
   *  current filters and sort (the endpoint's envelope). The export
   *  walks every page with it. */
  fetchPage?: (page: number, perPage: number) => Promise<CsvPage<T>>;
  /** For a list the browser already holds whole (sorted and
   *  filtered, before ``pageOf``): exported as given. */
  allRows?: T[];
  /** Data the file should carry that the table has no column for
   *  (a transfer's fee and tax behind its total), after the table's
   *  own columns. */
  extraColumns?: CsvColumn<T>[];
  /** "resource.action" a person needs to see the button. Exporting
   *  takes data out of the app, so it is the Data export page's
   *  right, ``reports.read``, unless a list says otherwise. */
  perm?: string;
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
  /** Adds the "Export CSV" button above the table. */
  exportCsv?: DataTableExport<T>;
}

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, rowLabel, rowClassName,
  isLoading = false, isError = false, error, onRetry,
  errorMessage, emptyTitle, emptyBody, page, sort, expandedRow, footer,
  exportCsv,
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
      {exportCsv && canDo(exportCsv.perm ?? EXPORT_PERM) && (
        <div className={styles.toolbar}>
          <ExportButton spec={exportCsv} columns={columns} rowKey={rowKey} />
        </div>
      )}
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

const EXPORT_PERM = "reports.read";

function ExportButton<T>({
  spec, columns, rowKey,
}: {
  spec: DataTableExport<T>;
  columns: DataColumn<T>[];
  rowKey: (row: T, index: number) => string | number;
}) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const all = spec.fetchPage
        ? await fetchAllPages(spec.fetchPage)
        : spec.allRows ?? [];
      const { headers, data } = exportTable(
        columns, all, rowKey, spec.extraColumns,
      );
      saveCsv(buildCsv(headers, data), csvFilename(spec.filename));
    } catch (err) {
      toast({
        tone: "error",
        message: err instanceof CsvTooLargeError
          ? t("table.exportTooLarge", {
            count: fmtNumber(err.total), max: fmtNumber(CSV_MAX_ROWS),
          })
          : apiErrorMessage(err, t("table.exportFailed")),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button tone="secondary" size="sm" busy={busy} onClick={() => { void run(); }}>
      {busy ? t("table.exporting") : t("table.exportCsv")}
    </Button>
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
