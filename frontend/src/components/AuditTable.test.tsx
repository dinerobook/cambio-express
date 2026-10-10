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

  it("defaults the second column to Actor", () => {
    render(<AuditTable rows={[]} />);
    expect(screen.getByRole("columnheader", { name: "Actor" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Store" })).toBeNull();
  });

  // "My activity" is one person's feed across stores: the actor is
  // always the reader, so the column says WHERE instead of WHO.
  it("who='store' shows the store in place of the actor", () => {
    render(
      <AuditTable
        who="store"
        rows={[{
          ts: "2026-10-08T14:00:00", store_name: "Plaza Fiesta",
          action: "create", target_type: "transfer", target_id: "7",
          target_label: "Transfer #7", summary: "sent $100",
          source: "transfer",
        }, {
          ts: "2026-10-08T13:00:00", store_name: "",
          action: "lock", target_type: "daily_report", target_id: "1",
          target_label: "", summary: "", source: "operator",
        }]}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Store" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Actor" })).toBeNull();
    expect(screen.getByText("Plaza Fiesta")).toBeInTheDocument();
    expect(screen.getByText("Transfer #7")).toBeInTheDocument();
    expect(screen.getByText("sent $100")).toBeInTheDocument();
    // Missing store / summary render a dash, not an empty cell.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
