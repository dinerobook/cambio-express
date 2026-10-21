import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataTable, type DataColumn } from "./DataTable";
import { ApiError } from "../../lib/api";

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
