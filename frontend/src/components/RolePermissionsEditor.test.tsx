import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RolePermissionsEditor } from "./RolePermissionsEditor";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// The one role-permissions editor behind Platform → Permissions, an
// owner's store permissions and the superadmin store page. A
// privilege-escalation surface (Auth INVARIANTS): pinned here are
// what is sent (only changed, editable roles — a role sent to a
// store endpoint becomes that store's override), what is locked or
// hidden, and that a reset always asks first.

const URL = "/api/v2/owner/store/7/permissions";
const row = (on: Partial<Record<string, boolean>> = {}) => ({
  create: false, read: false, update: false, delete: false, ...on,
});
function grid(over: { editable?: string[]; overrides?: string[] } = {}) {
  return {
    roles: ["admin", "employee", "support"],
    editable_roles: over.editable ?? ["admin", "employee"],
    has_overrides: over.overrides ?? [],
    resources: ["transfers"],
    actions: ["create", "read", "update", "delete"],
    matrix: {
      admin: { transfers: row({ read: true }) },
      employee: { transfers: row({ read: true }) },
      support: { transfers: row() },
    },
  };
}

function render(handlers: Record<string, MockHandler>, props: { hideLockedRoles?: boolean } = {}) {
  const calls = mockFetch(handlers);
  renderRoute(<RolePermissionsEditor endpoint={URL} queryKey={["t", 7]} {...props} />);
  return calls;
}

beforeEach(() => { signInAs({ role: "owner", store_id: 7, permissions: [] }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("RolePermissionsEditor", () => {
  it("sends only the role that changed, never an untouched editable one", async () => {
    const calls = render({
      [`GET ${URL}`]: { body: grid() },
      [`PUT ${URL}`]: { body: grid({ overrides: ["employee"] }) },
    });
    await userEvent.click(await screen.findByLabelText("Create — Money transfers (employee)"));
    await userEvent.click(screen.getByLabelText("Edit — Money transfers (employee)"));
    await userEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    expect(await screen.findByText("2 permissions updated.")).toBeInTheDocument();
    expect(callsTo(calls, `PUT ${URL}`)[0].body).toEqual({
      matrix: { employee: { transfers: row({ read: true, create: true, update: true }) } },
    });
  });

  it("locks a role the caller cannot change", async () => {
    render({ [`GET ${URL}`]: { body: grid() } });
    const box = await screen.findByLabelText("Create — Money transfers (support)");
    expect(box).toBeDisabled();
    expect(screen.getByText("View only")).toBeInTheDocument();
  });

  it("leaves locked roles out with hideLockedRoles", async () => {
    render({ [`GET ${URL}`]: { body: grid() } }, { hideLockedRoles: true });
    expect(await screen.findByLabelText("Create — Money transfers (admin)")).toBeEnabled();
    expect(screen.queryByLabelText("Create — Money transfers (support)")).not.toBeInTheDocument();
  });

  it("ticks every action of a resource from the All column", async () => {
    const calls = render({
      [`GET ${URL}`]: { body: grid() },
      [`PUT ${URL}`]: { body: grid() },
    });
    await userEvent.click(await screen.findByLabelText("All actions — transfers (admin)"));
    for (const a of ["Create", "View", "Edit", "Delete"]) {
      expect(screen.getByLabelText(`${a} — Money transfers (admin)`)).toBeChecked();
    }
    await userEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    await screen.findByText("3 permissions updated.");
    expect(callsTo(calls, `PUT ${URL}`)[0].body).toEqual({
      matrix: { admin: { transfers: row({ create: true, read: true, update: true, delete: true }) } },
    });
  });

  it("confirms a reset before posting it", async () => {
    const calls = render({
      [`GET ${URL}`]: { body: grid({ overrides: ["employee"] }) },
      [`POST ${URL}/reset`]: { body: grid() },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Reset to defaults" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset employee permissions?" });
    expect(callsTo(calls, `POST ${URL}/reset`)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Reset to defaults" }));
    expect(await screen.findByText("Employee permissions reset to the defaults.")).toBeInTheDocument();
    expect(callsTo(calls, `POST ${URL}/reset`)[0].body).toEqual({ role: "employee" });
  });

  it("shows a load error with a retry", async () => {
    let fail = true;
    render({
      [`GET ${URL}`]: () => (fail
        ? { status: 500, body: { detail: "Down." } }
        : { body: grid() }),
    });
    expect(await screen.findByText("Down.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(await screen.findByLabelText("Create — Money transfers (admin)")).toBeInTheDocument();
  });
});
