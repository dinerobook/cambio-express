import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TableStates } from "./TableStates";
import { ApiError } from "../../lib/api";

// TableStates decides which ONE guard a list shows: loading beats
// error beats empty, and nothing at all once rows are present.

const base = {
  isLoading: false, isError: false, isEmpty: false,
  onRetry: () => {}, emptyTitle: "No rows yet.",
};

describe("<TableStates>", () => {
  it("shows a skeleton while loading, even if an error is also flagged", () => {
    const { container } = render(<TableStates {...base} isLoading isError rows={2} cols={3} />);
    expect(container.querySelectorAll(".ds-skel")).toHaveLength(6);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses the error's own message when no errorMessage is given", () => {
    render(
      <TableStates {...base} isError error={new ApiError(500, "Database down", null)} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Database down");
  });

  it("prefers the caller's errorMessage and retries on click", async () => {
    const onRetry = vi.fn();
    render(
      <TableStates
        {...base} isError error={new Error("raw")} onRetry={onRetry}
        errorMessage="Could not load transfers"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load transfers");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("falls back to a generic message for a non-Error", () => {
    render(<TableStates {...base} isError error="boom" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load data");
  });

  it("shows the empty title when there are no rows", () => {
    render(<TableStates {...base} isEmpty emptyBody="Add one to start." />);
    expect(screen.getByText("No rows yet.")).toBeInTheDocument();
    expect(screen.getByText("Add one to start.")).toBeInTheDocument();
  });

  it("renders nothing when data is present", () => {
    const { container } = render(<TableStates {...base} />);
    expect(container).toBeEmptyDOMElement();
  });
});
