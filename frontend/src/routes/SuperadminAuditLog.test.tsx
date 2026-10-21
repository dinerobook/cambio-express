import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminAuditLog from "./SuperadminAuditLog";
import { renderRoute, signInAs } from "../test/renderRoute";

// Platform audit log: superadmin only; action search, page and rows
// per page reach the query; rows render through the shared table.

const useSuperadminAuditLog = vi.fn();
vi.mock("../api/superadmin", async (orig) => ({
  ...(await orig<typeof import("../api/superadmin")>()),
  useSuperadminAuditLog: (...a: unknown[]) => useSuperadminAuditLog(...a),
}));

function ok() {
  return {
    data: {
      rows: [{
        id: 1, created_at: "2026-10-08T14:00:00", admin_name: "Platform Admin",
        action: "extend_trial", target_type: "store", target_id: "7",
        details: "+14 days",
      }],
      total: 80, page: 1, total_pages: 2,
    },
    isLoading: false, isError: false, error: null, refetch: vi.fn(),
  };
}

describe("Superadmin audit log", () => {
  beforeEach(() => {
    useSuperadminAuditLog.mockReset();
    useSuperadminAuditLog.mockReturnValue(ok());
    window.localStorage.removeItem("db.page_size.superadmin-audit-log");
  });

  it("is closed to anyone but the superadmin", () => {
    renderRoute(<SuperadminAuditLog />);
    expect(screen.getByText("Superadmin scope required.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("lists entries and pages through them", async () => {
    signInAs({ role: "superadmin", store_id: null });
    const user = userEvent.setup();
    renderRoute(<SuperadminAuditLog />);
    expect(screen.getByText("Platform Admin")).toBeInTheDocument();
    expect(screen.getByText("+14 days")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 80")).toBeInTheDocument();
    expect(useSuperadminAuditLog.mock.lastCall).toEqual([1, "", 50]);
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(useSuperadminAuditLog.mock.lastCall).toEqual([2, "", 50]));
    await user.selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() => expect(useSuperadminAuditLog.mock.lastCall).toEqual([1, "", 100]));
  });
});
