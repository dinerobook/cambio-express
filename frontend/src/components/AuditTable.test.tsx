import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AuditTable } from "./AuditTable";

// One table for the store admin's Audit log and the superadmin
// store page's Activity section. The actor column shows the name
// the server wrote, which during an impersonation already carries
// "(via superadmin …)".
describe("<AuditTable>", () => {
  it("renders actor, action, target and summary per row", () => {
    render(
      <AuditTable

        rows={[{
          ts: "2026-10-08T14:00:00", user_name: "cashier (via superadmin Platform Admin)",
          user_role: "employee", action: "update", target_type: "transfer",
          target_id: "41", target_label: "Transfer #41", summary: "fee 5 → 6",
          source: "operator",
        }, {
          ts: "2026-10-08T13:00:00", user_name: "", user_role: "",
          action: "lock", target_type: "daily_report", target_id: "2026-10-07",
          target_label: "", summary: "", source: "operator",
        }]}
      />,
    );
    expect(screen.getByText("cashier (via superadmin Platform Admin)")).toBeInTheDocument();
    expect(screen.getByText("(employee)")).toBeInTheDocument();
    expect(screen.getByText("update")).toBeInTheDocument();
    expect(screen.getByText("Transfer #41")).toBeInTheDocument();
    expect(screen.getByText("fee 5 → 6")).toBeInTheDocument();
    expect(screen.getByText("lock")).toBeInTheDocument();
    expect(screen.getByText("daily_report")).toBeInTheDocument();
    // A row with no actor or summary shows a dash, not a blank cell.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
