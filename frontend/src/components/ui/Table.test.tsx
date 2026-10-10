import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { Table, TableSkeleton } from "./Table";

describe("<Table>", () => {
  it("renders the caller's head and body inside a table", () => {
    render(
      <Table>
        <thead><tr><th>Name</th></tr></thead>
        <tbody><tr><td>Store A</td></tr></tbody>
      </Table>,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Store A" })).toBeInTheDocument();
  });

  it("merges a caller style over the defaults", () => {
    render(<Table style={{ width: "50%" }}><tbody /></Table>);
    expect(screen.getByRole("table")).toHaveStyle({ width: "50%" });
  });
});

describe("<TableSkeleton>", () => {
  it("renders rows × cols shimmer cells", () => {
    const { container } = render(<TableSkeleton rows={3} cols={2} />);
    expect(container.querySelectorAll(".ds-skel")).toHaveLength(6);
  });

  it("defaults to 5 × 4", () => {
    const { container } = render(<TableSkeleton />);
    expect(container.querySelectorAll(".ds-skel")).toHaveLength(20);
  });
});
