import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import Employees from "./Employees";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// Team → Employees. The hub where an admin deactivates people and
// turns a bare login into an HR record. Pinned: the list, the
// "no access, no control" rule on every action (users.create /
// users.update, and a login that outranks the viewer), the
// deactivate + adopt flows, and a refused / failed request.

const ANA = {
  id: 1, name: "Ana", is_active: true, hourly_rate: 15, hired_on: "2026-01-05",
  login: {
    user_id: 10, username: "ana", role: "employee", is_active: true,
    has_custom_permissions: false, store_role_name: "Shift lead", can_manage: true,
  },
};
const OWNER_ROW = {
  id: 2, name: "Olga Owner", is_active: true, hourly_rate: 0, hired_on: null,
  login: {
    user_id: 11, username: "olga", role: "owner", is_active: true,
    has_custom_permissions: false, store_role_name: null, can_manage: false,
  },
};
const GONE = {
  id: 3, name: "Gus", is_active: false, hourly_rate: 0, hired_on: null, login: null,
};
const LOGIN_ONLY = { user_id: 12, username: "carla", full_name: "Carla", role: "employee" };

function routes(extra: Record<string, MockHandler> = {}) {
  return {
    "GET /api/v2/admin/employees": {
      body: { rows: [ANA, OWNER_ROW, GONE], login_only: [LOGIN_ONLY] },
    },
    ...extra,
  };
}

const row = (name: string) => screen.getByText(name).closest("tr")!;

afterEach(() => { vi.unstubAllGlobals(); });

describe("Employees hub", () => {
  it("lists people with their login, saved role, rate and status", async () => {
    mockFetch(routes());
    renderRoute(<Employees />, { path: "/employees" });
    expect(await screen.findByText("Ana")).toBeInTheDocument();
    expect(within(row("Ana")).getByText("Shift lead")).toBeInTheDocument();
    expect(within(row("Ana")).getByText("$15.00/hr")).toBeInTheDocument();
    expect(within(row("Gus")).getByText("No login")).toBeInTheDocument();
    expect(within(row("Gus")).getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByText("Logins without an employee record")).toBeInTheDocument();
  });

  it("shows every action to a person with users.create + users.update", async () => {
    mockFetch(routes());
    renderRoute(<Employees />, { path: "/employees" });
    await screen.findByText("Ana");
    expect(screen.getByRole("link", { name: /Add Employee/ })).toBeInTheDocument();
    expect(within(row("Ana")).getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(within(row("Ana")).getByRole("button", { name: "Manage access" })).toBeInTheDocument();
    expect(within(row("Gus")).getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(within(row("carla")).getByRole("button", { name: "Create employee record" }))
      .toBeInTheDocument();
  });

  it("hides access and deactivate on a login that outranks the viewer", async () => {
    mockFetch(routes());
    renderRoute(<Employees />, { path: "/employees" });
    await screen.findByText("Olga Owner");
    const olga = row("Olga Owner");
    expect(within(olga).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(olga).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    expect(within(olga).queryByRole("button", { name: "Manage access" })).not.toBeInTheDocument();
  });

  it("hides every write control from a read-only viewer", async () => {
    signInAs({ without: ["users.create", "users.update", "users.delete"] });
    mockFetch(routes());
    renderRoute(<Employees />, { path: "/employees" });
    await screen.findByText("Ana");
    expect(screen.queryByRole("link", { name: /Add Employee/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create employee record" })).not.toBeInTheDocument();
  });

  it("deactivates after confirming", async () => {
    const calls = mockFetch(routes({
      "PATCH /api/v2/admin/employees/1": { body: { ...ANA, is_active: false } },
    }));
    renderRoute(<Employees />, { path: "/employees" });
    await screen.findByText("Ana");
    await userEvent.click(within(row("Ana")).getByRole("button", { name: "Deactivate" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByText("Ana deactivated.")).toBeInTheDocument();
    expect(callsTo(calls, "PATCH /api/v2/admin/employees/1")[0].body).toEqual({ is_active: false });
  });

  it("shows the server's refusal when deactivating is forbidden", async () => {
    mockFetch(routes({
      "PATCH /api/v2/admin/employees/1": {
        status: 403, body: { detail: "You can't manage this person." },
      },
    }));
    renderRoute(<Employees />, { path: "/employees" });
    await screen.findByText("Ana");
    await userEvent.click(within(row("Ana")).getByRole("button", { name: "Deactivate" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByText("You can't manage this person.")).toBeInTheDocument();
    expect(screen.queryByText("Ana deactivated.")).not.toBeInTheDocument();
  });

  it("creates an HR record for a login and opens it", async () => {
    const calls = mockFetch(routes({
      "POST /api/v2/admin/employees": { body: { ...ANA, id: 9, name: "Carla" } },
    }));
    renderRoute(<Employees />, { path: "/employees" });
    await screen.findByText("carla");
    await userEvent.click(screen.getByRole("button", { name: "Create employee record" }));
    expect(await screen.findByText("Navigated to /employees/9/edit")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/admin/employees")[0].body)
      .toEqual({ name: "Carla", user_id: 12 });
  });

  it("shows a 422 from creating the record and stays put", async () => {
    mockFetch(routes({
      "POST /api/v2/admin/employees": { status: 422, body: { detail: "Already linked." } },
    }));
    renderRoute(<Employees />, { path: "/employees" });
    await screen.findByText("carla");
    await userEvent.click(screen.getByRole("button", { name: "Create employee record" }));
    expect(await screen.findByText("Already linked.")).toBeInTheDocument();
    expect(screen.queryByText(/Navigated to/)).not.toBeInTheDocument();
  });

  it("shows the empty state for a store with nobody", async () => {
    mockFetch(routes({ "GET /api/v2/admin/employees": { body: { rows: [], login_only: [] } } }));
    renderRoute(<Employees />, { path: "/employees" });
    expect(await screen.findByText("No employees yet")).toBeInTheDocument();
  });

  it("offers a retry when the list fails", async () => {
    let fail = true;
    mockFetch(routes({
      "GET /api/v2/admin/employees": () => (fail
        ? { status: 500, body: { detail: "Database unavailable." } }
        : { body: { rows: [ANA], login_only: [] } }),
    }));
    renderRoute(<Employees />, { path: "/employees" });
    expect(await screen.findByText("Database unavailable.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Ana")).toBeInTheDocument();
  });
});
