import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Gate from "../components/Gate";
import { filterNavForRole, SUPPORT_LINK } from "../components/navConfig";
import AdminDataExport from "../routes/AdminDataExport";
import AdminUserForm from "../routes/AdminUserForm";
import OwnerBulkAddUser from "../routes/OwnerBulkAddUser";
import { ACCOUNTANT_PAGES, canAccessWith, homePathFor } from "./access";
import { setCurrentIdentity } from "./auth";
import { accountTypeLabel } from "./permissions";
import { callsTo, mockFetch } from "../test/fetchMock";
import { renderRouteWithGuard } from "../test/renderRoute";
import { TEST_ADMIN } from "../test/setup";

// The Accountant (idea D1): a view-only sign-in for the store's
// bookkeeper or CPA. The server holds the real lock (fixed grants +
// a route list, tests/Core/test_accountant_role.py); these pin the
// SPA side of "no access, no control": the accountant is only ever
// shown Reports, the monthly P&L, the tax pack and their own
// account, lands on Reports, and the people who manage them get a
// role picker that never offers access the server would refuse.

const accountant = {
  role: "accountant",
  permissions: ["monthly.read", "reports.read"],
};

function signInAccountant() {
  setCurrentIdentity({ ...TEST_ADMIN, ...accountant });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("accountant page access", () => {
  it("opens reports, the monthly P&L, the tax pack and their own account", () => {
    for (const to of [
      "/reports", "/reports/sales-by-company", "/monthly",
      "/admin/data-export", "/settings/profile", "/settings/security",
      "/account/activity", "/account/sessions",
    ]) {
      expect(canAccessWith(accountant, to), to).toBe(true);
    }
  });

  it("is refused everything else, open pages included", () => {
    for (const to of [
      "/dashboard", "/hub/daily", "/daily", "/daily/edit", "/monthly/edit",
      "/monthly/categories", "/transfers", "/customers", "/batches",
      "/bank-transactions", "/employees", "/team/roles", "/timeclock",
      "/settings/general", "/settings/money-services", "/settings/billing",
      "/admin/audit-log", "/store-reports", "/account/notifications",
      "/account/tickets", "/owner/reports", "/superadmin/stores",
    ]) {
      expect(canAccessWith(accountant, to), to).toBe(false);
    }
  });

  it("an admin keeps every page they had, the audit log included", () => {
    const admin = { role: "admin", permissions: TEST_ADMIN.permissions };
    for (const to of ["/dashboard", "/admin/audit-log", "/monthly/edit", "/account/notifications"]) {
      expect(canAccessWith(admin, to), to).toBe(true);
    }
  });

  it("every listed page is a real route the table covers", () => {
    for (const p of ACCOUNTANT_PAGES) {
      expect(canAccessWith(accountant, p.replace("/*", "/x")), p).toBe(true);
    }
  });

  it("lands on Reports; everyone else on the dashboard", () => {
    expect(homePathFor(accountant)).toBe("/reports");
    expect(homePathFor({ role: "admin", permissions: [] })).toBe("/dashboard");
    expect(homePathFor(null)).toBe("/dashboard");
  });
});

function Where() {
  return <p>At {useLocation().pathname}</p>;
}

describe("Gate for an accountant", () => {
  it("sends a refused page to Reports, never to a dashboard that would bounce again", () => {
    signInAccountant();
    render(
      <MemoryRouter initialEntries={["/transfers"]}>
        <Routes>
          <Route path="/reports" element={<Where />} />
          <Route path="/dashboard" element={<Where />} />
          <Route path="*" element={<Gate><p>Protected page</p></Gate>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("At /reports")).toBeInTheDocument();
    expect(screen.queryByText("Protected page")).not.toBeInTheDocument();
  });

  it("lets them open the monthly P&L", () => {
    signInAccountant();
    render(
      <MemoryRouter initialEntries={["/monthly"]}>
        <Routes>
          <Route path="*" element={<Gate><p>Protected page</p></Gate>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Protected page")).toBeInTheDocument();
  });
});

describe("accountant sidebar", () => {
  it("shows Reports (with the P&L and tax pack) and Account only", () => {
    const groups = filterNavForRole("accountant", accountant.permissions, []);
    expect(groups.map((g) => g.title)).toEqual(["Reports", "Account"]);
    const reports = groups[0].items.map((i) => i.to);
    expect(reports).toEqual(["/reports", "/monthly", "/admin/data-export"]);
    const account = groups[1].items.map((i) => i.to);
    expect(account).toEqual(["/settings", "/account/activity", "/account/sessions"]);
    expect(canAccessWith(accountant, SUPPORT_LINK.to)).toBe(false);
  });

  it("an admin's Reports menu is unchanged", () => {
    const groups = filterNavForRole("admin", TEST_ADMIN.permissions, ["module_day_close"]);
    const reports = groups.find((g) => g.title === "Reports");
    expect(reports?.items.map((i) => i.to)).toEqual(["/reports", "/store-reports"]);
  });

  it("names the role Accountant on team lists", () => {
    expect(accountTypeLabel("accountant")).toBe("Accountant");
    expect(accountTypeLabel("employee")).toBe("Employee");
  });
});

describe("Data export for an accountant", () => {
  beforeEach(() => {
    mockFetch({
      "GET /api/v2/admin/tax-export/years": { body: { years: [2025], default_year: 2025 } },
    });
  });

  function renderPage() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><AdminDataExport /></MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("shows the tax pack and report CSVs, hides downloads the server would refuse", () => {
    signInAccountant();
    renderPage();
    expect(screen.getByText("Year-end tax pack (ZIP)")).toBeInTheDocument();
    expect(screen.getByText("Transfers (custom range)")).toBeInTheDocument();
    expect(screen.getByText("Journal entries (accounting)")).toBeInTheDocument();
    expect(screen.queryByText("Customer directory")).toBeNull();
    expect(screen.queryByText("Time-clock entries (custom range)")).toBeNull();
    expect(screen.queryByText("Audit log")).toBeNull();
  });

  it("an admin still sees every download", () => {
    renderPage();
    for (const title of [
      "Year-end tax pack (ZIP)", "Customer directory",
      "Time-clock entries (custom range)", "Audit log",
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });
});

describe("adding an accountant on Team", () => {
  function routes(assignable: string[]) {
    return {
      "GET /api/v2/admin/users": { body: { rows: [], assignable_roles: assignable } },
      "GET /api/v2/auth/session-status": { body: {} },
      "GET /api/v2/admin/roles": { body: { resources: [], actions: [], roles: [] } },
      "GET /api/v2/admin/store-permissions": {
        body: { roles: [], editable_roles: [], resources: [], actions: [], matrix: {}, has_overrides: [] },
      },
      "POST /api/v2/auth/refresh": { status: 401, body: {} },
      "POST /api/v2/admin/users": { body: { id: 31, username: "cpa@example.com" } },
    };
  }

  it("an admin picks Accountant, sees what it means, and no access grid is sent", async () => {
    const calls = mockFetch(routes(["admin", "employee", "accountant"]));
    const user = userEvent.setup();
    renderRouteWithGuard(<AdminUserForm />, { path: "/admin/users/new" });
    await user.type(await screen.findByLabelText(/^Email/), "cpa@example.com");
    await user.type(screen.getByLabelText(/^Password/), "ledger-pass-1");
    const picker = screen.getByLabelText(/^Account type/);
    await screen.findByRole("option", { name: "Accountant (view only)" });
    await user.selectOptions(picker, "accountant");
    expect(screen.getByText(/View only: reports, the monthly P&L and the tax pack/)).toBeInTheDocument();
    // The access picker and module filter do not apply to a fixed role.
    expect(screen.queryByLabelText("Role")).toBeNull();
    expect(screen.queryByText("Module access")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("Navigated to /employees")).toBeInTheDocument();
    const body = callsTo(calls, "POST /api/v2/admin/users")[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ email: "cpa@example.com", role: "accountant", module_access: null });
    expect(body).not.toHaveProperty("permissions");
    expect(body).not.toHaveProperty("store_role_id");
  });

  it("is not offered to someone who may not hand it out", async () => {
    mockFetch(routes(["employee"]));
    renderRouteWithGuard(<AdminUserForm />, { path: "/admin/users/new" });
    const picker = await screen.findByLabelText(/^Account type/);
    await screen.findByRole("option", { name: "Employee" });
    expect(within(picker).queryByRole("option", { name: "Accountant (view only)" })).toBeNull();
  });
});

const bulkAddUser = vi.fn();
vi.mock("../api/owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/owner")>()),
  useOwnerLocations: () => ({
    data: { rows: [
      { store_id: 1, store_name: "Downtown", store_slug: "downtown" },
      { store_id: 2, store_name: "Uptown", store_slug: "uptown" },
    ] },
    isLoading: false, isError: false, refetch: vi.fn(),
  }),
  bulkAddUser: (...a: unknown[]) => bulkAddUser(...a),
}));

describe("owner adds one accountant to several stores", () => {
  it("sends the accountant role for every picked store", async () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "owner", store_id: null });
    bulkAddUser.mockResolvedValue({ created: 2, skipped: 0, rejected: 0, results: [] });
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><OwnerBulkAddUser /></MemoryRouter>
      </QueryClientProvider>,
    );
    await user.type(screen.getByPlaceholderText("manager@example.com"), "cpa@example.com");
    await user.type(screen.getByLabelText(/^Password/), "ledger-pass-1");
    await user.selectOptions(screen.getByLabelText(/^Role/), "accountant");
    expect(screen.getByText(/They pick the store when they sign in/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: /Create/ }));
    expect(bulkAddUser).toHaveBeenCalledTimes(1);
    expect(bulkAddUser.mock.calls[0][0]).toMatchObject({
      email: "cpa@example.com", role: "accountant", store_ids: [1, 2],
    });
  });
});
