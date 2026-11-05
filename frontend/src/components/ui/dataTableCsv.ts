import type { CsvValue } from "../../lib/csv";
import type { CsvColumn, DataColumn } from "./DataTable";

// The CSV side of the kit `<DataTable>`: which columns a file gets
// and what each is called. Kept out of DataTable.tsx so that file
// exports components only (React fast refresh).

/** The phone-card label of a column: ``label`` when set, else the
 *  header when it is plain text, else nothing. */
export function cardLabel<T>(c: DataColumn<T>): string {
  if (c.label != null) return c.label;
  return typeof c.header === "string" ? c.header : "";
}

/** The header and data rows of a CSV export: the columns that have
 *  a ``csv`` value, in table order. Rows the paging walk saw twice (a
 *  new row landing between two page requests shifts the pages by
 *  one) are written once. Exported for the tests. */
export function exportTable<T>(
  columns: DataColumn<T>[],
  rows: T[],
  rowKey: (row: T, index: number) => string | number,
  extraColumns: CsvColumn<T>[] = [],
): { headers: string[]; data: CsvValue[][] } {
  const cols: CsvColumn<T>[] = [
    ...columns.filter((c) => c.csv).map((c) => ({
      header: c.csvHeader || cardLabel(c) || c.key,
      csv: c.csv!,
    })),
    ...extraColumns,
  ];
  const seen = new Set<string | number>();
  const data: CsvValue[][] = [];
  rows.forEach((row, index) => {
    const key = rowKey(row, index);
    if (seen.has(key)) return;
    seen.add(key);
    data.push(cols.map((c) => c.csv(row)));
  });
  return { headers: cols.map((c) => c.header), data };
}

