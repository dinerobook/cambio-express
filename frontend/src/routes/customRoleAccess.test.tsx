import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminAuditLog from "./AdminAuditLog";
import AdminDataExport from "./AdminDataExport";
import AdminUserForm from "./AdminUserForm";
import EmployeeForm from "./EmployeeForm";
import { ToastProvider } from "../components/ui";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Roles are not permissions (UI-STANDARDS §8). These pages are
// guarded by <Gate> from lib/access.ts and by the API's
// require_permission; they used to ALSO refuse anyone whose account
// type wasn't admin/owner, so a custom access role that grants
// users.* or reports.read got "You need a store-admin sign-in".

const NO_SESSION = { data: undefined, isLoading: false, isError: false };

vi.mock("../api/admin", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/admin")>();
  return {
    ...real,
    useAdminAuditLog: () => ({
      data: {
        rows: [], total: 0, page: 1, per_page: 50, total_pages: 1,
        users: [],
      },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    }),
    useAdminUser: () => NO_SESSION,
    useAdminUsers: () => ({
      data: { users: [], assignable_roles: ["employee"] },
      isLoading: false, isError: false,
    }),
    useAdminUserPermissions: () => NO_SESSION,
  };
});
vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    useTaxExportYears: () => ({ data: { years: [2025], default_year: 2025 } }),
    useSessionStatus: () => NO_SESSION,
  };
});
vi.mock("../api/roles", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/roles")>();
  return {
    ...real,
    useAccessRoles: () => ({ data: { roles: [] }, isLoading: false }),
    useBuiltinRoles: () => NO_SESSION,
  };
});
vi.mock("../api/employees", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/employees")>();
  return {
    ...real,
    useEmployees: () => ({
      data: { rows: [], login_only: [] }, isLoading: false, isError: false,
    }),
  };
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const REFUSAL = /store-admin sign-in/;

// An employee-type login on a custom role: the account type is
// "employee", the rights are whatever the role grants.
function customRole(permissions: string[]) {
  setCurrentIdentity({ ...TEST_ADMIN, role: "employee", permissions });
}

beforeEach(() => {
  setCurrentIdentity(TEST_ADMIN);
});

describe("pages open to a custom role holding the right", () => {
  it("Audit log with reports.read", () => {
    customRole(["reports.read"]);
    wrap(<AdminAuditLog />);
    expect(screen.queryByText(REFUSAL)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Audit log/ })).toBeInTheDocument();
  });

  it("Data export with reports.read", () => {
    customRole(["reports.read"]);
    wrap(<AdminDataExport />);
    expect(screen.queryByText(REFUSAL)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Data export" })).toBeInTheDocument();
  });

  it("Add employee with users.create", () => {
    customRole(["users.read", "users.create"]);
    wrap(<EmployeeForm />);
    expect(screen.queryByText(REFUSAL)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Add Employee" })).toBeInTheDocument();
  });

  it("Add login with users.create", () => {
    customRole(["users.read", "users.create"]);
    wrap(<AdminUserForm />);
    expect(screen.queryByText(REFUSAL)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Add Login" })).toBeInTheDocument();
  });
});
