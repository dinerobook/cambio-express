import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Pager } from "./Pager";

describe("<Pager>", () => {
  it("renders the page indicator", () => {
    render(<Pager page={2} totalPages={5} onPage={() => {}} />);
    expect(screen.getByText("2 / 5")).toBeInTheDocument();
  });

  it("fires onPage with next page when Next clicked", async () => {
    const user = userEvent.setup();
    const onPage = vi.fn();
    render(<Pager page={2} totalPages={5} onPage={onPage} />);
    await user.click(screen.getByRole("button", { name: /Next/i }));
    expect(onPage).toHaveBeenCalledWith(3);
  });

  it("fires onPage with previous page when Prev clicked", async () => {
    const user = userEvent.setup();
    const onPage = vi.fn();
    render(<Pager page={3} totalPages={5} onPage={onPage} />);
    await user.click(screen.getByRole("button", { name: /Prev/i }));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it("disables Prev on first page", () => {
    render(<Pager page={1} totalPages={5} onPage={() => {}} />);
    expect(screen.getByRole("button", { name: /Prev/i })).toBeDisabled();
  });

  it("disables Next on last page", () => {
    render(<Pager page={5} totalPages={5} onPage={() => {}} />);
    expect(screen.getByRole("button", { name: /Next/i })).toBeDisabled();
  });

  it("renders nothing when totalPages <= 1 and no leading content", () => {
    const { container } = render(
      <Pager page={1} totalPages={1} onPage={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders leading content even when totalPages <= 1", () => {
    render(
      <Pager
        page={1} totalPages={1} onPage={() => {}}
        leading={<span>Total: $99</span>}
      />,
    );
    expect(screen.getByText("Total: $99")).toBeInTheDocument();
  });

  it("says which rows are showing, even on a single page", () => {
    render(<Pager page={1} totalPages={1} onPage={() => {}} total={12} pageRows={12} />);
    expect(screen.getByText("Showing 1–12 of 12")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Next/ })).not.toBeInTheDocument();
  });

  it("counts a short last page from the end", () => {
    render(<Pager page={3} totalPages={3} onPage={() => {}} total={105} pageRows={5} />);
    expect(screen.getByText("Showing 101–105 of 105")).toBeInTheDocument();
  });

  it("hides the rows-per-page picker for a list of 25 or fewer", () => {
    render(
      <Pager page={1} totalPages={1} onPage={() => {}} total={20} pageRows={20}
        perPage={50} onPerPage={() => {}} />,
    );
    expect(screen.queryByLabelText("Rows per page")).not.toBeInTheDocument();
  });

  it("changes rows per page", async () => {
    const onPerPage = vi.fn();
    render(
      <Pager page={1} totalPages={1} onPage={() => {}} total={40} pageRows={40}
        perPage={50} onPerPage={onPerPage} />,
    );
    await userEvent.setup().selectOptions(screen.getByLabelText("Rows per page"), "25");
    expect(onPerPage).toHaveBeenCalledWith(25);
  });
});
