import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CheckChecks from "./CheckChecks";
import CheckCashingReport from "./CashedChecksReport";
import type { CashedCheckRow, CheckReport } from "../api/checkCashing";
import { filterNavForRole } from "../components/navConfig";
import { setLanguage } from "../i18n";
import { canAccess } from "../lib/access";
import { ApiError } from "../lib/api";
import { todayIso } from "../lib/datetime";
import { englishLeftovers } from "../test/i18n";
import { renderRoute, signInAs } from "../test/renderRoute";
import { TEST_ADMIN } from "../test/setup";

// The Checks page (check cashing app: every check, today by default,
// the period's summary on top) and the back office Check cashing
// report (view only, any device, owners included). CheckCashing
// INVARIANTS "Checks and reports". Checked in Spanish too.

const api = vi.hoisted(() => ({
  useCheckDevice: vi.fn(),
  useChecks: vi.fn(),
  useCheckReport: vi.fn(),
}));

vi.mock("../api/checkCashing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/checkCashing")>()),
  ...api,
}));

const READER = ["check_cashing.read"];

const ok = <T,>(data: T) => ({
  data, isLoading: false, isError: false, error: null, isFetching: false,
  refetch: vi.fn(),
});

const row: CashedCheckRow = {
  id: 40, store_name: "Main St", store_day: "2026-11-11", created_at: "2026-11-11T15:00:00Z",
  customer_id: 7, customer_name: "Persona Prueba", company_id: 3,
  company_name: "Acme Payroll", check_number: "1001", check_date: null, amount: 500,
  fee: 10, cash: 490, status: "cashed", reason: "", void_reason: "",
  cashier_name: "Maria", warnings: [], approved: false, can_void: false,
  can_report_bad: false, bad_check: { id: 5, status: "open", reason: "nsf", balance: 525 },
};

const totals = { cashed: 3, amount: 1000, fees: 20, cash: 980, average: 333.33, declined: 1, voided: 1 };

const report: CheckReport = {
  from_day: "2026-11-01", to_day: "2026-11-11", totals,
  store_options: [{ id: 1, name: "Main St" }, { id: 2, name: "Second St" }],
  stores: [
    { store_id: 1, store_name: "Main St", ...totals, cashed: 2, amount: 800 },
    { store_id: 2, store_name: "Second St", ...totals, cashed: 1, amount: 200 },
  ],
  days: [{ day: "2026-11-11", ...totals }],
  companies: [{ id: 3, name: "Acme Payroll", cashed: 3, amount: 1000 }],
  customers: [{ id: 7, name: "Persona Prueba", cashed: 2, amount: 700 }],
  bad_checks: { open_count: 1, open_owed: 425, returned: 1, returned_owed: 525, paid_back: 100 },
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  signInAs({ permissions: [...TEST_ADMIN.permissions, ...READER] });
  api.useCheckDevice.mockReturnValue(ok({
    state: "this", name: "Front counter", activated_at: "2026-11-09T10:00:00Z",
    activated_by: "Admin", last_seen_at: "2026-11-09T10:00:00Z",
  }));
  api.useChecks.mockReturnValue(ok({ rows: [row], total: 1, page: 1, total_pages: 1 }));
  api.useCheckReport.mockReturnValue(ok(report));
});

describe("the Checks page", () => {
  it("opens on today's checks with the summary on top", () => {
    renderRoute(<CheckChecks />);
    const today = todayIso();
    expect(api.useChecks).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: today, to: today, status: "", q: "" }),
    );
    expect(api.useCheckReport).toHaveBeenLastCalledWith({ from: today, to: today });
    expect(screen.getByRole("heading", { name: "Checks" })).toBeInTheDocument();
    expect(screen.getByText("Checks cashed")).toBeInTheDocument();
    expect(screen.getByText("$980.00")).toBeInTheDocument();
    expect(screen.getByText("Persona Prueba")).toBeInTheDocument();
    expect(screen.getByText("Bad check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export CSV/i })).toBeInTheDocument();
  });

  it("filters by status and searches as you type", async () => {
    renderRoute(<CheckChecks />);
    await userEvent.click(screen.getByRole("tab", { name: "Not accepted" }));
    expect(api.useChecks).toHaveBeenLastCalledWith(expect.objectContaining({ status: "declined" }));
    await userEvent.type(screen.getByRole("searchbox"), "acme");
    await waitFor(() => expect(api.useChecks).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "acme" }),
    ));
  });

  it("opens the customer from a row", async () => {
    renderRoute(<CheckChecks />, { path: "/check-cashing/checks" });
    await userEvent.click(screen.getByText("Persona Prueba"));
    expect(await screen.findByText(/check-cashing\/customers\/7/)).toBeInTheDocument();
  });

  it("is in Spanish", () => {
    setLanguage("es");
    renderRoute(<CheckChecks />);
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

describe("the back office Check cashing report", () => {
  it("shows the period's totals, bad checks, stores, days and top parties", () => {
    renderRoute(<CheckCashingReport />);
    expect(screen.getByRole("heading", { name: "Check cashing report" })).toBeInTheDocument();
    expect(screen.getByText("Open bad checks")).toBeInTheDocument();
    expect(screen.getByText("$425.00 still owed")).toBeInTheDocument();
    expect(screen.getByText("By store")).toBeInTheDocument();
    expect(screen.getByText("Second St", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText("Top companies")).toBeInTheDocument();
    expect(screen.getAllByText("Acme Payroll").length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue("2026-11-01")).toBeInTheDocument();
  });

  it("picks one store and a period", async () => {
    renderRoute(<CheckCashingReport />);
    await userEvent.selectOptions(screen.getByLabelText("Store"), "2");
    expect(api.useCheckReport).toHaveBeenLastCalledWith(expect.objectContaining({ storeId: "2" }));
  });

  it("hides the store picker and the by-store table for one store", () => {
    api.useCheckReport.mockReturnValue(ok({
      ...report, store_options: [report.store_options[0]], stores: [report.stores[0]],
    }));
    renderRoute(<CheckCashingReport />);
    expect(screen.queryByLabelText("Store")).not.toBeInTheDocument();
    expect(screen.queryByText("By store")).not.toBeInTheDocument();
  });

  it("says when nothing happened in the period", () => {
    api.useCheckReport.mockReturnValue(ok({
      ...report, days: [], companies: [], customers: [], stores: [],
    }));
    renderRoute(<CheckCashingReport />);
    expect(screen.getAllByText("No checks in this period").length).toBe(3);
  });

  it("shows a load error with a retry", () => {
    api.useCheckReport.mockReturnValue({
      ...ok(undefined), isError: true, error: new ApiError(403, "Check cashing is not turned on for this store.", {}),
    });
    renderRoute(<CheckCashingReport />);
    expect(screen.getByRole("button", { name: /Retry|Try again/ })).toBeInTheDocument();
  });

  it("is in the Reports menu for admins and owners only where check cashing is on", () => {
    const labels = (role: string, perms: string[], flags: string[]) =>
      filterNavForRole(role, perms, flags).flatMap((g) => g.items.map((i) => i.label));
    expect(labels("admin", [...TEST_ADMIN.permissions, ...READER], ["check_desk"]))
      .toContain("Check cashing report");
    expect(labels("admin", [...TEST_ADMIN.permissions, ...READER], []))
      .not.toContain("Check cashing report");
    expect(labels("admin", TEST_ADMIN.permissions.filter((p) => !p.startsWith("check_cashing")),
      ["check_desk"])).not.toContain("Check cashing report");
    expect(labels("owner", [], ["check_desk_report"])).toContain("Check cashing report");
    expect(labels("owner", [], [])).not.toContain("Check cashing report");
    expect(labels("accountant", ["reports.read"], ["check_desk"]))
      .not.toContain("Check cashing report");
  });

  it("guards each path", () => {
    signInAs({ permissions: READER });
    expect(canAccess("/reports/check-cashing")).toBe(true);
    expect(canAccess("/check-cashing/checks")).toBe(true);
    signInAs({ permissions: ["reports.read"] });
    expect(canAccess("/reports/check-cashing")).toBe(false);
    expect(canAccess("/owner/reports/check-cashing")).toBe(false);
  });

  it("is in Spanish", () => {
    setLanguage("es");
    renderRoute(<CheckCashingReport />);
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});
