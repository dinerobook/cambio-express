import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataTable, type DataColumn, type DataTableProps } from "./DataTable";
import { exportTable } from "./dataTableCsv";
import { ToastProvider } from "./Toast";
import { ApiError } from "../../lib/api";
import { csvMoney } from "../../lib/csv";
import { csvTimestamp, setDisplayTimezone } from "../../lib/datetime";
import { setLanguage } from "../../i18n";

// DataTable is the one list table: columns declared once, the three
// guard states, rows that open by mouse or keyboard, sortable headers,
// the shared pager, and the phone-card labels.

interface Row { id: number; name: string; amount: number }

const rows: Row[] = [
  { id: 1, name: "Maria", amount: 10 },
  { id: 2, name: "Juan", amount: 25 },
];

const columns: DataColumn<Row>[] = [
  { key: "name", header: "Name", sortKey: "name", render: (r) => r.name },
  { key: "amount", header: "Amount", align: "right", sortKey: "amount", render: (r) => `$${r.amount}` },
  { key: "actions", header: <span>Actions</span>, label: "", render: () => "…" },
];

const base = {
  columns, rowKey: (r: Row) => r.id, emptyTitle: "No rows yet.",
};

describe("<DataTable>", () => {
  it("renders a header per column and a cell per row", () => {
    render(<DataTable {...base} rows={rows} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(["Name", "Amount", "Actions"]);
    const juan = screen.getByText("Juan").closest("tr")!;
    expect(within(juan).getByText("$25")).toHaveStyle({ textAlign: "right" });
  });

  it("labels every cell for the phone card view", () => {
    render(<DataTable {...base} rows={rows} />);
    const cells = within(screen.getByText("Maria").closest("tr")!).getAllByRole("cell");
    expect(cells.map((c) => c.getAttribute("data-label"))).toEqual(["Name", "Amount", ""]);
  });

  it("shows a skeleton while loading and no table", () => {
    const { container } = render(<DataTable {...base} rows={undefined} isLoading />);
    expect(container.querySelector(".ds-skel")).not.toBeNull();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the error with a retry, never the empty state", async () => {
    const onRetry = vi.fn();
    render(
      <DataTable {...base} rows={[]} isError onRetry={onRetry}
        error={new ApiError(500, "Database down", null)} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Database down");
    expect(screen.queryByText("No rows yet.")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows the empty state when there are no rows", () => {
    render(<DataTable {...base} rows={[]} />);
    expect(screen.getByText("No rows yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("rows are plain (not buttons) without onRowClick", () => {
    render(<DataTable {...base} rows={rows} />);
    expect(screen.getByText("Maria").closest("tr")).not.toHaveAttribute("role");
  });

  it("opens a row by click, Enter and Space", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable {...base} rows={rows} onRowClick={onRowClick}
        rowLabel={(r) => `Open ${r.name}`} />,
    );
    await user.click(screen.getByText("Maria"));
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);
    screen.getByRole("button", { name: "Open Juan" }).focus();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
    await user.keyboard(" ");
    expect(onRowClick).toHaveBeenCalledTimes(3);
  });

  it("does not open the row when a key is pressed inside a control in it", async () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        {...base}
        columns={[{ key: "b", header: "B", render: () => <button type="button">Inner</button> }]}
        rows={rows.slice(0, 1)}
        onRowClick={onRowClick}
        rowLabel={() => "Open row"}
      />,
    );
    screen.getByRole("button", { name: "Inner" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("marks the sorted column and sorts on header click", async () => {
    const onSort = vi.fn();
    render(
      <DataTable {...base} rows={rows}
        sort={{ key: "amount", direction: "asc", onSort }} />,
    );
    const headers = screen.getAllByRole("columnheader");
    expect(headers[1]).toHaveAttribute("aria-sort", "ascending");
    expect(headers[0]).toHaveAttribute("aria-sort", "none");
    expect(headers[2]).not.toHaveAttribute("aria-sort");
    const user = userEvent.setup();
    await user.click(within(headers[0]).getByRole("button"));
    expect(onSort).toHaveBeenLastCalledWith("name", "asc");
    // The active column flips.
    await user.click(within(headers[1]).getByRole("button"));
    expect(onSort).toHaveBeenLastCalledWith("amount", "desc");
  });

  it("starts a column at its sortFirst direction", async () => {
    const onSort = vi.fn();
    render(
      <DataTable {...base} rows={rows}
        columns={[{ key: "d", header: "Date", sortKey: "date", sortFirst: "desc", render: () => "" }]}
        sort={{ key: "other", direction: "asc", onSort }} />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /Date/ }));
    expect(onSort).toHaveBeenCalledWith("date", "desc");
  });

  it("headers are plain text when the table is not sortable", () => {
    render(<DataTable {...base} rows={rows} />);
    expect(within(screen.getAllByRole("columnheader")[0]).queryByRole("button")).toBeNull();
  });

  it("adds the shared pager with the row range", async () => {
    const onPage = vi.fn();
    render(
      <DataTable {...base} rows={rows}
        page={{ page: 2, totalPages: 3, total: 6, onPage }} />,
    );
    expect(screen.getByText("Showing 3–4 of 6")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /Next/ }));
    expect(onPage).toHaveBeenCalledWith(3);
  });

  it("offers rows per page when the list is longer than 25", async () => {
    const onPerPage = vi.fn();
    render(
      <DataTable {...base} rows={rows}
        page={{ page: 1, totalPages: 2, total: 60, onPage: () => {}, perPage: 50, onPerPage }} />,
    );
    await userEvent.setup().selectOptions(screen.getByLabelText("Rows per page"), "100");
    expect(onPerPage).toHaveBeenCalledWith(100);
  });

  it("shows a full-width panel under an expanded row", () => {
    render(
      <DataTable {...base} rows={rows} onRowClick={() => {}}
        rowLabel={(r) => `Open ${r.name}`}
        expandedRow={(r) => (r.id === 2 ? <p>Details for Juan</p> : null)} />,
    );
    const panel = screen.getByText("Details for Juan").closest("td")!;
    expect(panel).toHaveAttribute("colspan", "3");
    expect(screen.getByRole("button", { name: "Open Juan" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Open Maria" })).toHaveAttribute("aria-expanded", "false");
  });
});

// ── CSV export (UI-STANDARDS §7 "Export") ───────────────────────

interface Txn { id: number; who: string; amount: number; at: string }

const txns: Txn[] = [
  { id: 1, who: "Maria", amount: 10, at: "2026-11-05T15:00:00" },
  { id: 2, who: "=cmd", amount: -2.5, at: "2026-11-05T16:30:00" },
];

const txnColumns: DataColumn<Txn>[] = [
  { key: "who", header: "Customer", render: (r) => r.who, csv: (r) => r.who },
  { key: "amount", header: <b>Amount</b>, label: "Amount", render: (r) => `$${r.amount}`, csv: (r) => csvMoney(r.amount) },
  { key: "at", header: <i>When</i>, label: "", csvHeader: "When", render: () => "x", csv: (r) => csvTimestamp(r.at) },
  { key: "actions", header: "Actions", render: () => <button type="button">Edit</button> },
];

function signIn(role: string, permissions: string[]) {
  window.localStorage.setItem("db.identity", JSON.stringify({
    user_id: 1, username: "u", full_name: "U", role, store_id: 7, permissions,
  }));
}

/** Capture what the export saves instead of downloading it. */
function captureDownloads() {
  const saved: { name: string; blob: Blob }[] = [];
  let last: Blob | null = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => { last = b as Blob; return "blob:x"; });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, blob: last! });
  });
  return saved;
}

async function text(blob: Blob): Promise<string> {
  return (await blob.text()).replace(/^\uFEFF/, "");
}

function renderExport(props: Partial<DataTableProps<Txn>>) {
  return render(
    <ToastProvider>
      <DataTable
        columns={txnColumns} rows={txns} rowKey={(r) => r.id}
        emptyTitle="None." {...props}
      />
    </ToastProvider>,
  );
}

describe("<DataTable exportCsv>", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setDisplayTimezone("America/Chicago");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setDisplayTimezone(null);
  });

  it("has no button unless the list asks for it", () => {
    signIn("admin", ["reports.read"]);
    renderExport({});
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("hides the button from someone without Reports access (deny)", () => {
    signIn("employee", ["transfers.read"]);
    renderExport({ exportCsv: { filename: "t", allRows: txns } });
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("shows it once Reports access is granted (grant)", () => {
    signIn("employee", ["transfers.read", "reports.read"]);
    renderExport({ exportCsv: { filename: "t", allRows: txns } });
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
  });

  it("follows a list's own permission when it names one", () => {
    signIn("admin", ["reports.read"]);
    renderExport({ exportCsv: { filename: "t", allRows: txns, perm: "users.read" } });
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("superadmin always sees it", () => {
    signIn("superadmin", []);
    renderExport({ exportCsv: { filename: "t", allRows: txns } });
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
  });

  it("has no button while the list is empty", () => {
    signIn("admin", ["reports.read"]);
    renderExport({ rows: [], exportCsv: { filename: "t", allRows: [] } });
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("exports the whole list: data columns only, store time, plain money, formulas defused", async () => {
    signIn("admin", ["reports.read"]);
    const saved = captureDownloads();
    renderExport({ exportCsv: { filename: "transfers", allRows: txns } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toMatch(/^transfers-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(await text(saved[0].blob)).toBe(
      "Customer,Amount,When\r\n"
      + "Maria,10.00,2026-11-05 09:00\r\n"
      + "'=cmd,-2.50,2026-11-05 10:30\r\n",
    );
  });

  it("walks every page of a paged list, not just the one on screen", async () => {
    signIn("admin", ["reports.read"]);
    const saved = captureDownloads();
    const fetchPage = vi.fn((p: number) => Promise.resolve({
      rows: [{ id: p, who: `P${p}`, amount: p, at: "" }],
      total: 3, total_pages: 3,
    }));
    renderExport({
      page: { page: 1, totalPages: 3, total: 3, onPage: () => {} },
      exportCsv: { filename: "t", fetchPage },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(fetchPage.mock.calls.map(([p]) => p)).toEqual([1, 2, 3]);
    expect(await text(saved[0].blob)).toBe(
      "Customer,Amount,When\r\nP1,1.00,\r\nP2,2.00,\r\nP3,3.00,\r\n",
    );
  });

  it("writes a row the paging walk saw twice only once", async () => {
    signIn("admin", ["reports.read"]);
    const saved = captureDownloads();
    // A new row landed between page 1 and page 2: row 2 slid onto page 2.
    const pages = [[txns[0], txns[1]], [txns[1]]];
    renderExport({
      exportCsv: {
        filename: "t",
        fetchPage: (p) => Promise.resolve({ rows: pages[p - 1], total: 3, total_pages: 2 }),
      },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((await text(saved[0].blob)).split("\r\n").filter(Boolean)).toHaveLength(3);
  });

  it("says when the list is too big and saves nothing", async () => {
    signIn("admin", ["reports.read"]);
    const saved = captureDownloads();
    renderExport({
      exportCsv: {
        filename: "t",
        fetchPage: () => Promise.resolve({ rows: txns, total: 25_000, total_pages: 250 }),
      },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText(/This list has 25,000 rows, more than the 10,000/)).toBeInTheDocument();
    expect(saved).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  });

  it("toasts a server failure and lets the person try again (failure)", async () => {
    signIn("admin", ["reports.read"]);
    const saved = captureDownloads();
    const fetchPage = vi.fn()
      .mockRejectedValueOnce(new ApiError(403, "Forbidden", null))
      .mockResolvedValue({ rows: txns, total: 2, total_pages: 1 });
    renderExport({ exportCsv: { filename: "t", fetchPage } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Forbidden")).toBeInTheDocument();
    expect(saved).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saved).toHaveLength(1));
  });

  it("is busy (and can't be pressed twice) while the export runs", async () => {
    signIn("admin", ["reports.read"]);
    captureDownloads();
    type Page = { rows: Txn[]; total: number; total_pages: number };
    let finish: (v: Page) => void = () => {};
    const fetchPage = vi.fn(() => new Promise<Page>((r) => { finish = r; }));
    renderExport({ exportCsv: { filename: "t", fetchPage } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Export CSV" }));
    const busy = screen.getByRole("button", { name: "Exporting…" });
    expect(busy).toBeDisabled();
    finish({ rows: txns, total: 2, total_pages: 1 });
    expect(await screen.findByRole("button", { name: "Export CSV" })).toBeEnabled();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("speaks the person's language", () => {
    signIn("admin", ["reports.read"]);
    setLanguage("es");
    try {
      renderExport({ exportCsv: { filename: "t", allRows: txns } });
      expect(screen.getByRole("button", { name: "Exportar CSV" })).toBeInTheDocument();
    } finally {
      setLanguage("en");
    }
  });
});

describe("exportTable", () => {
  it("skips columns with no csv value and falls back label → key for headers", () => {
    const cols: DataColumn<Txn>[] = [
      { key: "who", header: <b>x</b>, render: () => "", csv: (r) => r.who },
      { key: "n", header: <b>x</b>, label: "Number", render: () => "", csv: (r) => r.id },
      { key: "skip", header: "Skip", render: () => "" },
    ];
    expect(exportTable(cols, txns, (r) => r.id)).toEqual({
      headers: ["who", "Number"],
      data: [["Maria", 1], ["=cmd", 2]],
    });
  });
});
