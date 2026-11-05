import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AuditTable } from "./AuditTable";
import { auditActionLabel, auditTargetLabel } from "./auditFilters";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// One table for the store admin's Audit log and the superadmin
// store page's Activity section. The actor column shows the name
// the server wrote, which during an impersonation already carries
// "(via superadmin …)".
describe("<AuditTable>", () => {
  it("renders actor, action, target and summary per row", () => {
    render(
      <AuditTable
        emptyTitle="No activity."
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
    expect(screen.getByText("(Employee)")).toBeInTheDocument();
    expect(screen.getByText("Update")).toBeInTheDocument();
    expect(screen.getByText("Transfer #41")).toBeInTheDocument();
    expect(screen.getByText("fee 5 → 6")).toBeInTheDocument();
    expect(screen.getByText("Lock")).toBeInTheDocument();
    expect(screen.getByText("Daily report")).toBeInTheDocument();
    // A row with no actor or summary shows a dash, not a blank cell.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("defaults the second column to Actor", () => {
    render(
      <AuditTable
        emptyTitle="No activity."
        rows={[{
          ts: "2026-10-08T14:00:00", user_name: "a", user_role: "", action: "update",
          target_type: "batch", target_id: "1", target_label: "", summary: "", source: "operator",
        }]}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Actor" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Store" })).toBeNull();
  });

  // "My activity" is one person's feed across stores: the actor is
  // always the reader, so the column says WHERE instead of WHO.
  it("who='store' shows the store in place of the actor", () => {
    render(
      <AuditTable
        emptyTitle="No activity."
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

  it("shows the empty state, the error with retry, and the pager", async () => {
    const { rerender } = render(<AuditTable emptyTitle="No activity." rows={[]} />);
    expect(screen.getByText("No activity.")).toBeInTheDocument();
    rerender(<AuditTable emptyTitle="No activity." rows={undefined} isError error={new Error("x")} onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(
      <AuditTable
        emptyTitle="No activity."
        rows={[{
          ts: "2026-10-08T14:00:00", user_name: "a", user_role: "", action: "update",
          target_type: "batch", target_id: "1", target_label: "", summary: "", source: "operator",
        }]}
        page={{ page: 3, totalPages: 3, total: 101, onPage: () => {} }}
      />,
    );
    expect(screen.getByText("Showing 101–101 of 101")).toBeInTheDocument();
  });
});

describe("<AuditTable> in Spanish", () => {
  it("names the columns, actions, targets and roles in Spanish", () => {
    setLanguage("es");
    render(
      <AuditTable
        emptyTitle="Sin actividad."
        who="both"
        rows={[{
          ts: "2026-10-08T14:00:00", user_name: "Ana", user_role: "admin",
          store_name: "Plaza Fiesta", action: "status_changed", target_type: "batch",
          target_id: "3", target_label: "", summary: "", source: "operator",
        }]}
      />,
    );
    for (const name of ["Cuándo", "Tienda", "Quién", "Acción", "Objeto", "Detalles"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("(Administrador)")).toBeInTheDocument();
    expect(screen.getByText("Cambio de estado")).toBeInTheDocument();
    expect(screen.getByText("Lote ACH")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["audit.", "role."])).toEqual([]);
  });

  it("shows a slug it doesn't know as the server sent it", () => {
    setLanguage("es");
    expect(auditActionLabel("refunded")).toBe("refunded");
    expect(auditTargetLabel("bank_rule")).toBe("bank_rule");
    // Own keys only: "constructor" is on every object.
    expect(auditActionLabel("constructor")).toBe("constructor");
    expect(auditActionLabel("deleted")).toBe("Eliminado");
    expect(auditTargetLabel("daily_report")).toBe("Libro diario");
  });
});
