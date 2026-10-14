import type { ComponentType } from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockFetch, type MockHandler } from "../../test/fetchMock";
import { renderRoute, signInAs } from "../../test/renderRoute";

// Every drill-down report page under routes/reports/ is a thin
// config over components/ReportDrilldown. One table-driven test
// renders each with data, with no rows, and with a failed load, so a
// column renderer that throws on a real row (or a page that drops
// the shared states) fails here. New report pages are picked up
// automatically through the glob.

const modules = import.meta.glob<{ default: ComponentType }>(
  ["./*.tsx", "!./*.test.tsx", "!./SuperadminBIDrilldown.tsx"],
  { eager: true },
);
const PAGES = Object.entries(modules).map(([file, mod]) => ({
  name: file.replace("./", "").replace(".tsx", ""),
  Page: mod.default,
}));

// One row carrying every field any page reads, so each column has
// something real to format.
const ROW = {
  label: "Zeta line", company: "Zeta line", country: "Zeta line",
  customer: "Zeta line", employee: "Zeta line", recipient: "Zeta line",
  recipient_name: "Zeta line", sender_name: "Zeta line", service_type: "Zeta line",
  status: "Zeta line", status_notes: "Zeta line", target: "Zeta line",
  match: "Zeta line", bucket: "Zeta line", cashier: "Zeta line",
  account: "1234", phone: "+15125550100", confirm: "ABC123",
  amount: 1234.5, avg: 10, count: 3, customers: 2, fee: 5, fees: 15,
  recovered: 1, sent: 1000, signed: -20, tax: 1.5, txns: 3, pct: 0.25,
  current: 10, prior: 8, delta: 2, is_money: true, is_active: true,
  date: "2026-10-09", send_date: "2026-10-09", first_logged: "2026-10-01",
  last_logged: "2026-10-09", last: "2026-10-09", note: "note",
};
const TOTALS = {
  amount: 1234.5, avg_per_day: 10, canceled: 1, count: 3, customers: 2,
  employees: 1, expenses: 100, fees: 15, inflow: 2000, outflow: 500,
  net_gl: 1500, net_income: 400, new_count: 1, returning_count: 2,
  ratio: 0.1, recovered: 1, rejected: 0, revenue: 500, rules: 2, sent: 1000,
  tax: 1.5, current_label: "Oct 2026", prior_label: "Sep 2026",
};

function reports(handler: MockHandler) {
  return mockFetch({ "GET /api/v2/reports/*": handler });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("report drill-down pages", () => {
  it("finds all 22 pages", () => {
    expect(PAGES).toHaveLength(22);
  });

  describe.each(PAGES)("$name", ({ Page }) => {
    it("renders the server's rows and KPIs for the signed-in store", async () => {
      const calls = reports({ body: { rows: [ROW], totals: TOTALS } });
      renderRoute(<Page />, { path: "/reports/x", at: "/reports/x?from=2026-10-01&to=2026-10-13" });
      const table = await screen.findByRole("table");
      expect(within(table).getAllByRole("row")).toHaveLength(2);
      expect(screen.getByText(/^1 /)).toBeInTheDocument();
      const url = calls[0].url;
      expect(url.searchParams.get("from")).toBe("2026-10-01");
      expect(url.searchParams.get("to")).toBe("2026-10-13");
      expect(url.searchParams.get("store_ids")).toBe("1");
    });

    it("shows the empty state for a period with no rows", async () => {
      reports({ body: { rows: [], totals: {} } });
      renderRoute(<Page />, { path: "/reports/x" });
      expect(await screen.findByText("No data in this period.")).toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("shows the server's error with a retry that reloads", async () => {
      let fail = true;
      reports(() => (fail
        ? { status: 403, body: { detail: "Missing report access." } }
        : { body: { rows: [ROW], totals: TOTALS } }));
      renderRoute(<Page />, { path: "/reports/x" });
      expect(await screen.findByText("Couldn't load report — Missing report access."))
        .toBeInTheDocument();
      fail = false;
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByRole("table")).toBeInTheDocument();
    });
  });

  it("asks a person with no store to sign in to one, without fetching", async () => {
    signInAs({ role: "owner", store_id: null });
    const calls = reports({ body: { rows: [], totals: {} } });
    const Page = PAGES[0].Page;
    renderRoute(<Page />, { path: "/owner/reports/x" });
    expect(screen.getByText("Sign in to a store to see this report.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });
});
