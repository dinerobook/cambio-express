import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminPermissions from "./SuperadminPermissions";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// Platform → Permissions: the default grid for every store's roles.
// The server replaces a role's whole grid, so the save must send
// only the roles that changed, each in full; nothing is fetched for
// anyone but the superadmin.

const row = (on: Partial<Record<string, boolean>> = {}) => ({
  create: false, read: false, update: false, delete: false, ...on,
});
const MATRIX = {
  roles: ["admin", "employee"],
  resources: ["transfers"],
  actions: ["create", "read", "update", "delete"],
  matrix: {
    admin: { transfers: row({ create: true, read: true, update: true, delete: true }) },
    employee: { transfers: row({ read: true }) },
  },
};

function routes(extra: Record<string, MockHandler> = {}) {
  return { "GET /api/v2/superadmin/permissions": { body: MATRIX }, ...extra };
}

beforeEach(() => { signInAs({ role: "superadmin", store_id: null, permissions: [] }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Superadmin permissions", () => {
  it("draws one grid per role and starts clean", async () => {
    mockFetch(routes());
    renderRoute(<SuperadminPermissions />);
    expect(await screen.findByLabelText("Delete — Money transfers (admin)")).toBeChecked();
    expect(screen.getByLabelText("Delete — Money transfers (employee)")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save permissions" })).toBeDisabled();
  });

  it("sends only the changed role, in full", async () => {
    const saved = { ...MATRIX, matrix: { ...MATRIX.matrix, employee: { transfers: row({ read: true, create: true }) } } };
    const calls = mockFetch(routes({ "PUT /api/v2/superadmin/permissions": { body: saved } }));
    renderRoute(<SuperadminPermissions />);
    await userEvent.click(await screen.findByLabelText("Create — Money transfers (employee)"));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    expect(await screen.findByText("1 permission updated.")).toBeInTheDocument();
    expect(callsTo(calls, "PUT /api/v2/superadmin/permissions")[0].body).toEqual({
      matrix: { employee: { transfers: row({ read: true, create: true }) } },
    });
  });

  it("Discard changes drops the unsaved toggles", async () => {
    mockFetch(routes());
    renderRoute(<SuperadminPermissions />);
    const box = await screen.findByLabelText("Create — Money transfers (employee)");
    await userEvent.click(box);
    expect(box).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("Create — Money transfers (employee)")).not.toBeChecked();
  });

  it("shows a refused save and keeps the edit", async () => {
    mockFetch(routes({
      "PUT /api/v2/superadmin/permissions": { status: 422, body: { detail: "Unknown resource." } },
    }));
    renderRoute(<SuperadminPermissions />);
    await userEvent.click(await screen.findByLabelText("Create — Money transfers (employee)"));
    await userEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    expect(await screen.findByText("Unknown resource.")).toBeInTheDocument();
    expect(screen.getByLabelText("Create — Money transfers (employee)")).toBeChecked();
  });

  it("fetches nothing for anyone but the superadmin", async () => {
    signInAs({ role: "admin" });
    const calls = mockFetch(routes());
    renderRoute(<SuperadminPermissions />);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Save permissions" })).not.toBeInTheDocument();
  });

  it("offers a retry when the matrix fails to load", async () => {
    let fail = true;
    mockFetch(routes({
      "GET /api/v2/superadmin/permissions": () => (fail
        ? { status: 500, body: { detail: "Policy store unavailable." } }
        : { body: MATRIX }),
    }));
    renderRoute(<SuperadminPermissions />);
    expect(await screen.findByText("Policy store unavailable.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Delete — Money transfers (admin)")).toBeInTheDocument();
  });
});
