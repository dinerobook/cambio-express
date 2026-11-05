import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import AdminUserForm from "./AdminUserForm";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRouteWithGuard } from "../test/renderRoute";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// Team → New login. The page had no tests. Pinned: creating a login
// sends the typed fields and returns to Employees without asking; a
// refusal stays on the form with the server's reason; leaving a
// half-typed login asks first.

function routes(extra: Record<string, MockHandler> = {}) {
  return {
    "GET /api/v2/admin/users": { body: { rows: [] } },
    "GET /api/v2/auth/session-status": { body: {} },
    "GET /api/v2/admin/roles": { body: { resources: [], actions: [], roles: [] } },
    "GET /api/v2/admin/store-permissions": {
      body: { roles: [], editable_roles: [], resources: [], actions: [], matrix: {}, has_overrides: [] },
    },
    "POST /api/v2/auth/refresh": { status: 401, body: {} },
    ...extra,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

const renderNew = () =>
  renderRouteWithGuard(<AdminUserForm />, { path: "/admin/users/new" });

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/^Email/), "luis@example.com");
  await user.type(screen.getByLabelText("Full name"), "Luis Paz");
  await user.type(screen.getByLabelText(/^Password/), "s3cret-pass");
}

describe("AdminUserForm — new login", () => {
  it("creates the login and returns to Employees without asking", async () => {
    const calls = mockFetch(routes({
      "POST /api/v2/admin/users": { body: { id: 30, username: "luis@example.com" } },
    }));
    const user = userEvent.setup();
    renderNew();
    await fill(user);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("Navigated to /employees")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull();
    const body = callsTo(calls, "POST /api/v2/admin/users")[0].body as Record<string, unknown>;
    expect(body).toMatchObject({
      email: "luis@example.com", full_name: "Luis Paz", password: "s3cret-pass",
    });
  });

  it("keeps the form and shows the server's refusal", async () => {
    mockFetch(routes({
      "POST /api/v2/admin/users": { status: 409, body: { detail: "That email already has a login." } },
    }));
    const user = userEvent.setup();
    renderNew();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("That email already has a login.")).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveValue("Luis Paz");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("asks before Cancel or the sidebar drops a half-typed login", async () => {
    mockFetch(routes());
    const user = userEvent.setup();
    const { router } = renderNew();
    await user.type(await screen.findByLabelText("Full name"), "Luis");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Full name")).toHaveValue("Luis");
    act(() => { void router.navigate("/dashboard"); });
    await user.click(await screen.findByRole("button", { name: "Leave" }));
    expect(await screen.findByText("Navigated to /dashboard")).toBeInTheDocument();
  });
});

describe("AdminUserForm in Spanish", () => {
  it("shows the new-login form and the accountant note in Spanish", async () => {
    setLanguage("es");
    mockFetch(routes({
      "GET /api/v2/admin/users": {
        body: { rows: [], assignable_roles: ["admin", "employee", "accountant"] },
      },
    }));
    const user = userEvent.setup();
    renderNew();
    expect(await screen.findByRole("heading", { name: "Agregar acceso" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Administrador (acceso total)" })).toHaveValue("admin");
    expect(englishLeftovers(document.body, ["userForm.", "common.", "role."])).toEqual([]);
    expect(await screen.findByRole("option", { name: "Contador (solo lectura)" }))
      .toHaveValue("accountant");
    await user.selectOptions(screen.getByLabelText(/^Tipo de cuenta/), "accountant");
    expect(screen.getByText(/^Solo lectura: reportes/)).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["userForm.", "common.", "role."])).toEqual([]);
  });
});
