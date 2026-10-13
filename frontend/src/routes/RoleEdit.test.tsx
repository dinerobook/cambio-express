import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import RoleEdit from "./RoleEdit";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// One role's page (Team → Roles & access → a role). A save here
// changes what people can do right away, so pin who may save at all
// (users.update for a saved role, settings.update for a built-in),
// creating a role (plain and from a person's custom access), and that
// a refused save or a failed load is shown rather than swallowed.
// The member-confirmation flow lives in RolesAccess.test.tsx.

const row = (on: Partial<Record<string, boolean>> = {}) => ({
  create: false, read: false, update: false, delete: false, ...on,
});
const RESOURCES = ["transfers", "monthly"];
const ACTIONS = ["create", "read", "update", "delete"];
const ROLES = {
  resources: RESOURCES, actions: ACTIONS,
  roles: [{
    id: 2, name: "Closer", member_count: 0, updated_at: null,
    matrix: { transfers: row({ read: true }), monthly: row() },
  }],
};
const BUILTIN = {
  roles: ["admin", "employee"], editable_roles: ["employee"],
  resources: RESOURCES, actions: ACTIONS,
  matrix: {
    admin: { transfers: row({ create: true, read: true, update: true, delete: true }), monthly: row({ read: true }) },
    employee: { transfers: row({ create: true, read: true }), monthly: row() },
  },
  has_overrides: ["employee"],
};
const USERS = {
  rows: [{ id: 12, username: "carla", full_name: "Carla", role: "employee",
    is_active: true, has_custom_permissions: true, store_role_id: null }],
};

function routes(extra: Record<string, MockHandler> = {}) {
  return {
    "GET /api/v2/admin/roles": { body: ROLES },
    "GET /api/v2/admin/store-permissions": { body: BUILTIN },
    "GET /api/v2/admin/users": { body: USERS },
    "GET /api/v2/admin/roles/2/members": { body: { role_id: 2, name: "Closer", members: [] } },
    "GET /api/v2/admin/users/12/permissions": {
      body: { matrix: { transfers: row({ read: true, update: true }), monthly: row() } },
    },
    "POST /api/v2/auth/refresh": { status: 401, body: {} },
    ...extra,
  };
}

const PATH = "/team/roles/:roleId";

afterEach(() => { vi.unstubAllGlobals(); });

describe("RoleEdit — saved role", () => {
  it("saves an edit to a role nobody is in", async () => {
    const calls = mockFetch(routes({
      "PUT /api/v2/admin/roles/2": { body: { ...ROLES.roles[0], affected_members: [] } },
    }));
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/2" });
    await userEvent.click(await screen.findByLabelText("View — Monthly P&L (Closer)"));
    await userEvent.click(screen.getByRole("button", { name: "Save role" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(await screen.findByText("Navigated to /team/roles")).toBeInTheDocument();
    const body = callsTo(calls, "PUT /api/v2/admin/roles/2")[0].body as {
      name: string; matrix: Record<string, Record<string, boolean>>;
    };
    expect(body.name).toBe("Closer");
    expect(body.matrix.monthly.read).toBe(true);
  });

  it("keeps the form and shows the server's refusal", async () => {
    mockFetch(routes({
      "PUT /api/v2/admin/roles/2": {
        status: 403, body: { detail: "You can't grant what you don't hold." },
      },
    }));
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/2" });
    await userEvent.click(await screen.findByLabelText("View — Monthly P&L (Closer)"));
    await userEvent.click(screen.getByRole("button", { name: "Save role" }));
    expect(await screen.findByText("You can't grant what you don't hold.")).toBeInTheDocument();
    expect(screen.queryByText(/Navigated to/)).not.toBeInTheDocument();
  });

  it("is read-only without users.update", async () => {
    signInAs({ without: ["users.update"] });
    mockFetch(routes());
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/2" });
    expect(await screen.findByLabelText("View — Monthly P&L (Closer)")).toBeDisabled();
    expect(screen.getByText(/You don't have the access needed to change it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save role" })).not.toBeInTheDocument();
  });

  it("says so when the role does not exist", async () => {
    mockFetch(routes());
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/99" });
    expect(await screen.findByText("Could not load this role.")).toBeInTheDocument();
  });

  it("offers a retry when the roles fail to load", async () => {
    let fail = true;
    mockFetch(routes({
      "GET /api/v2/admin/roles": () => (fail ? { status: 500, body: {} } : { body: ROLES }),
    }));
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/2" });
    expect(await screen.findByText("Could not load this role.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("View — Monthly P&L (Closer)")).toBeInTheDocument();
  });
});

describe("RoleEdit — new role", () => {
  it("creates a role from a template", async () => {
    const calls = mockFetch(routes({
      "POST /api/v2/admin/roles": { body: { ...ROLES.roles[0], id: 7, name: "Shift lead" } },
    }));
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/new" });
    await userEvent.type(await screen.findByPlaceholderText("Shift lead"), "Shift lead");
    await userEvent.selectOptions(screen.getByRole("combobox"), "employee");
    await userEvent.click(screen.getByRole("button", { name: "Create role" }));
    expect(await screen.findByText("Role created.")).toBeInTheDocument();
    const body = callsTo(calls, "POST /api/v2/admin/roles")[0].body as {
      name: string; matrix: Record<string, Record<string, boolean>>;
    };
    expect(body.name).toBe("Shift lead");
    expect(body.matrix.transfers).toEqual(row({ create: true, read: true }));
  });

  it("shows a 422 from creating a duplicate name", async () => {
    mockFetch(routes({
      "POST /api/v2/admin/roles": { status: 422, body: { detail: "A role with that name exists." } },
    }));
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/new" });
    await userEvent.type(await screen.findByPlaceholderText("Shift lead"), "Closer");
    await userEvent.click(screen.getByRole("button", { name: "Create role" }));
    expect(await screen.findByText("A role with that name exists.")).toBeInTheDocument();
  });

  it("turns a person's custom access into a role and puts them in it", async () => {
    const calls = mockFetch(routes({
      "POST /api/v2/admin/roles": { body: { ...ROLES.roles[0], id: 8, name: "Carla's job" } },
      "PUT /api/v2/admin/users/12/role": { body: { store_role_id: 8, store_role_name: "Carla's job" } },
    }));
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/new?from_user=12" });
    expect(await screen.findByLabelText("Edit — Money transfers (New role)")).toBeChecked();
    expect(screen.getByText("Will follow this role")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Shift lead"), "Carla's job");
    await userEvent.click(screen.getByRole("button", { name: "Create role" }));
    expect(await screen.findByText("Role created. Carla now follows it.")).toBeInTheDocument();
    expect(callsTo(calls, "PUT /api/v2/admin/users/12/role")[0].body).toEqual({ role_id: 8 });
  });
});

describe("RoleEdit — built-in roles", () => {
  it("lets settings.update reset the Employee role to defaults", async () => {
    const calls = mockFetch(routes({
      "POST /api/v2/admin/store-permissions/reset": { body: { ...BUILTIN, has_overrides: [] } },
    }));
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/employee" });
    await userEvent.click(await screen.findByRole("button", { name: "Reset to DineroBook defaults" }));
    expect(await screen.findByText("Employee role reset to the DineroBook defaults.")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/admin/store-permissions/reset")[0].body)
      .toEqual({ role: "employee" });
  });

  it("shows a refused reset", async () => {
    mockFetch(routes({
      "POST /api/v2/admin/store-permissions/reset": { status: 403, body: { detail: "Not allowed." } },
    }));
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/employee" });
    await userEvent.click(await screen.findByRole("button", { name: "Reset to DineroBook defaults" }));
    expect(await screen.findByText("Not allowed.")).toBeInTheDocument();
  });

  it("is read-only, with no reset, without settings.update", async () => {
    signInAs({ without: ["settings.update"] });
    mockFetch(routes());
    renderRoute(<RoleEdit />, { path: PATH, at: "/team/roles/employee" });
    const box = await screen.findByLabelText("Edit — Money transfers (Employee)");
    expect(box).toBeDisabled();
    const form = box.closest("form")!;
    expect(within(form).queryByRole("button", { name: "Save role" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reset to DineroBook/ })).not.toBeInTheDocument();
  });
});
