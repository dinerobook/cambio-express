import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RolesAccess from "./RolesAccess";
import RoleEdit from "./RoleEdit";
import { ToastProvider } from "../components/ui";

// Team → Roles & access. Two things are worth pinning:
//   1. The roles list counts people correctly across built-in
//      roles, saved roles and hand-set access, so nobody silently
//      falls out of the picture.
//   2. Editing a saved role changes what its members can do RIGHT
//      NOW, so the save must NAME the people first, and must not
//      nag when the role has nobody in it.

const row = (on: Partial<Record<string, boolean>>) => ({
  create: false, read: false, update: false, delete: false, ...on,
});

const rolesResponse = {
  resources: ["transfers", "monthly"],
  actions: ["create", "read", "update", "delete"],
  roles: [
    {
      id: 1, name: "Shift lead", member_count: 2, updated_at: null,
      matrix: { transfers: row({ read: true }), monthly: row({}) },
    },
    {
      id: 2, name: "Nobody's role", member_count: 0, updated_at: null,
      matrix: { transfers: row({}), monthly: row({}) },
    },
  ],
};

const builtinResponse = {
  roles: ["admin", "employee"],
  editable_roles: ["employee"],
  resources: ["transfers", "monthly"],
  actions: ["create", "read", "update", "delete"],
  matrix: {
    admin: {
      transfers: row({ create: true, read: true, update: true, delete: true }),
      monthly: row({ read: true }),
    },
    employee: { transfers: row({ create: true, read: true }), monthly: row({}) },
  },
  has_overrides: [],
};

const usersResponse = {
  rows: [
    // Follows the built-in Employee role.
    { id: 10, username: "amber", full_name: "Amber", role: "employee",
      is_active: true, has_custom_permissions: false, store_role_id: null },
    // In a saved role (overlay present, but owned by the role).
    { id: 11, username: "ben", full_name: "Ben", role: "employee",
      is_active: true, has_custom_permissions: true, store_role_id: 1 },
    // Hand-set grid, no role.
    { id: 12, username: "carla", full_name: "Carla", role: "employee",
      is_active: true, has_custom_permissions: true, store_role_id: null },
  ],
};

const fetchRoleMembers = vi.fn();
const updateAccessRole = vi.fn();

vi.mock("../api/roles", () => ({
  useAccessRoles: () => ({
    data: rolesResponse, isLoading: false, isError: false, isSuccess: true,
  }),
  useBuiltinRoles: () => ({
    data: builtinResponse, isLoading: false, isError: false,
  }),
  fetchRoleMembers: (...args: unknown[]) => fetchRoleMembers(...args),
  updateAccessRole: (...args: unknown[]) => updateAccessRole(...args),
  createAccessRole: vi.fn(),
  deleteAccessRole: vi.fn(),
  assignAccessRole: vi.fn(),
  saveBuiltinRole: vi.fn(),
  resetBuiltinRole: vi.fn(),
}));

vi.mock("../api/admin", () => ({
  useAdminUsers: () => ({ data: usersResponse }),
  useAdminUserPermissions: () => ({ data: undefined }),
}));

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/team/roles" element={<RolesAccess />} />
            <Route path="/team/roles/by-area" element={<RolesAccess view="area" />} />
            <Route path="/team/roles/:roleId" element={<RoleEdit />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchRoleMembers.mockReset();
  updateAccessRole.mockReset();
  fetchRoleMembers.mockResolvedValue({
    role_id: 1, name: "Shift lead",
    members: [{ id: 10, name: "Amber" }, { id: 11, name: "Ben" }],
  });
  updateAccessRole.mockResolvedValue({
    ...rolesResponse.roles[0],
    affected_members: [{ id: 10, name: "Amber" }, { id: 11, name: "Ben" }],
  });
});

describe("Roles & access list", () => {
  it("shows built-in and saved roles with who is in each", () => {
    renderAt("/team/roles");
    const employee = screen.getByText("Employee").closest("tr")!;
    // Amber only: Ben is in a saved role, Carla has her own grid.
    expect(within(employee).getByText("1 person")).toBeInTheDocument();
    const lead = screen.getByText("Shift lead").closest("tr")!;
    expect(within(lead).getByText("2 people")).toBeInTheDocument();
    expect(within(lead).getByText("1 of 2")).toBeInTheDocument();
  });

  it("lists people with hand-set access so they aren't forgotten", () => {
    renderAt("/team/roles");
    const section = screen.getByText("People with custom access")
      .closest("section") ?? document.body;
    expect(within(section).getByText("Carla")).toBeInTheDocument();
    expect(within(section).queryByText("Ben")).not.toBeInTheDocument();
    expect(within(section).getByText("Save as role")).toBeInTheDocument();
  });

  it("offers Edit on the Employee role but only View on Admin", () => {
    renderAt("/team/roles");
    const admin = screen.getByText("Admin").closest("tr")!;
    expect(within(admin).getByText("View")).toBeInTheDocument();
    expect(within(admin).queryByText("Delete")).not.toBeInTheDocument();
    const employee = screen.getByText("Employee").closest("tr")!;
    expect(within(employee).getByText("Edit")).toBeInTheDocument();
  });

  it("draws every area against every role on the by-area tab", () => {
    renderAt("/team/roles/by-area");
    expect(
      screen.getByLabelText("Shift lead, Money transfers, View: yes"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Shift lead, Money transfers, Delete: no"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Admin, Money transfers, Delete: yes"),
    ).toBeInTheDocument();
  });
});

describe("Editing a saved role", () => {
  it("names the affected people before saving an edit", async () => {
    const user = userEvent.setup();
    renderAt("/team/roles/1");
    await user.click(
      await screen.findByLabelText("Edit — Money transfers (Shift lead)"),
    );
    await user.click(screen.getByText("Save role"));

    // The confirmation must say WHO; a bare count is not one.
    expect(await screen.findByText(/Amber, Ben/)).toBeInTheDocument();
    expect(screen.getByText(/signed out/)).toBeInTheDocument();
    // …and nothing is saved until it is confirmed.
    expect(updateAccessRole).not.toHaveBeenCalled();

    await user.click(screen.getByText("Save and update them"));
    await waitFor(() => expect(updateAccessRole).toHaveBeenCalledTimes(1));
  });

  it("does not ask for confirmation on a role with no members", async () => {
    const user = userEvent.setup();
    renderAt("/team/roles/2");
    await user.click(
      await screen.findByLabelText("View — Monthly P&L (Nobody's role)"),
    );
    await user.click(screen.getByText("Save role"));

    await waitFor(() => expect(updateAccessRole).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText("This changes people's access"),
    ).not.toBeInTheDocument();
  });
});
