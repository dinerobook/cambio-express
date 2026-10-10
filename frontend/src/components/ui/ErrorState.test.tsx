import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ErrorState } from "./ErrorState";

// ErrorState is the one fetch-failure block (UI-STANDARDS): an
// alert with the message, and a Retry button only when the caller
// can actually retry.

describe("<ErrorState>", () => {
  it("announces the message as an alert", () => {
    render(<ErrorState message="Could not load stores" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load stores");
  });

  it("renders no Retry button without onRetry", () => {
    render(<ErrorState message="Gone" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onRetry when Retry is clicked", async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Gone" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows a busy Retrying… label while a retry is in flight", () => {
    render(<ErrorState message="Gone" onRetry={() => {}} busy />);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeInTheDocument();
  });
});
