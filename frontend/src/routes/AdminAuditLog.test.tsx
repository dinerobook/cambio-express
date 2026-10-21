import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminAuditLog from "./AdminAuditLog";
import { renderRoute } from "../test/renderRoute";

// Store audit log: filters, page and rows-per-page drive the query,
// the shared pager says which rows are showing, and a failed load
// offers a retry.

const useAdminAuditLog = vi.fn();
vi.mock("../api/admin", async (orig) => ({
  ...(await orig<typeof import("../api/admin")>()),
  useAdminAuditLog: (...a: unknown[]) => useAdminAuditLog(...a),
}));

const row = {
  ts: "2026-10-08T14:00:00", user_name: "Rosa", user_role: "employee",
  action: "update", target_type: "transfer", target_id: "41",
  target_label: "Transfer #41", summary: "fee 5 → 6", source: "operator",
};

function ok(over: Record<string, unknown> = {}) {
  return {
    data: {
      rows: [row], total: 120, page: 1, per_page: 50, total_pages: 3,
      store_users: [{ id: 9, label: "Rosa", role: "employee" }],
      target_filter: "", action_filter: "", user_filter: "",
      ...over,
    },
    isLoading: false, isError: false, error: null, refetch: vi.fn(),
  };
}

const args = () => useAdminAuditLog.mock.lastCall!;

describe("Admin audit log", () => {
  beforeEach(() => {
    useAdminAuditLog.mockReset();
    useAdminAuditLog.mockReturnValue(ok());
    window.localStorage.removeItem("db.page_size.admin-audit-log");
  });

  it("shows the rows and which of them are on screen", () => {
    renderRoute(<AdminAuditLog />);
    expect(screen.getByText("Rosa")).toBeInTheDocument();
    expect(screen.getByText("Transfer #41")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 120")).toBeInTheDocument();
    expect(args()).toEqual([1, "", "", "", 50]);
  });

  it("reads filters and page from the URL", () => {
    renderRoute(<AdminAuditLog />, { at: "/?target=batch&user=9&page=2" });
    expect(args()).toEqual([2, "batch", "", "9", 50]);
  });

  it("a filter change returns to page 1", async () => {
    renderRoute(<AdminAuditLog />, { at: "/?page=3" });
    await userEvent.setup().selectOptions(screen.getByLabelText("Action"), "lock");
    await waitFor(() => expect(args()).toEqual([1, "", "lock", "", 50]));
  });

  it("pages forward and changes rows per page", async () => {
    const user = userEvent.setup();
    renderRoute(<AdminAuditLog />);
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(args()[0]).toBe(2));
    await user.selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() => expect(args()).toEqual([1, "", "", "", 100]));
  });

  it("clears every filter", async () => {
    renderRoute(<AdminAuditLog />, { at: "/?action=lock&page=2" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(args()).toEqual([1, "", "", "", 50]));
  });

  it("says so when nothing matches", () => {
    useAdminAuditLog.mockReturnValue(ok({ rows: [], total: 0, total_pages: 1 }));
    renderRoute(<AdminAuditLog />);
    expect(screen.getByText("No activity matches these filters.")).toBeInTheDocument();
  });

  it("offers a retry when the load fails", async () => {
    const refetch = vi.fn();
    useAdminAuditLog.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new Error("down"), refetch,
    });
    renderRoute(<AdminAuditLog />);
    await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });
});
