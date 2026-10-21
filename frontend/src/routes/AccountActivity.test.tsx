import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AccountActivity from "./AccountActivity";
import { renderRoute } from "../test/renderRoute";

// "My activity": one person's feed across stores. Store column in
// place of the actor; filters, page and rows-per-page in the query.

const useMyActivity = vi.fn();
vi.mock("../api/account", async (orig) => ({
  ...(await orig<typeof import("../api/account")>()),
  useMyActivity: (...a: unknown[]) => useMyActivity(...a),
}));

function ok(over: Record<string, unknown> = {}) {
  return {
    data: {
      rows: [{
        ts: "2026-10-08T14:00:00", action: "create", target_type: "transfer",
        target_id: "7", target_label: "Transfer #7", summary: "sent $100",
        source: "transfer", store_id: 1, store_name: "Plaza Fiesta",
      }],
      total: 60, page: 1, per_page: 50, total_pages: 2,
      target_filter: "", action_filter: "",
      ...over,
    },
    isLoading: false, isError: false, error: null, refetch: vi.fn(),
  };
}

const args = () => useMyActivity.mock.lastCall![0];

describe("My activity", () => {
  beforeEach(() => {
    useMyActivity.mockReset();
    useMyActivity.mockReturnValue(ok());
    window.localStorage.removeItem("db.page_size.my-activity");
  });

  it("shows where each action happened", () => {
    renderRoute(<AccountActivity />);
    expect(screen.getByRole("columnheader", { name: "Store" })).toBeInTheDocument();
    expect(screen.getByText("Plaza Fiesta")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 60")).toBeInTheDocument();
  });

  it("drives filters, page and rows per page into the query", async () => {
    const user = userEvent.setup();
    renderRoute(<AccountActivity />, { at: "/?page=2" });
    expect(args()).toEqual({ target: "", action: "", page: 2, perPage: 50 });
    await user.selectOptions(screen.getByLabelText("Target"), "batch");
    await waitFor(() => expect(args()).toEqual({ target: "batch", action: "", page: 1, perPage: 50 }));
    await user.selectOptions(screen.getByLabelText("Rows per page"), "25");
    await waitFor(() => expect(args().perPage).toBe(25));
  });

  it("shows the empty state for a new person", () => {
    useMyActivity.mockReturnValue(ok({ rows: [], total: 0, total_pages: 1 }));
    renderRoute(<AccountActivity />);
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
  });
});
