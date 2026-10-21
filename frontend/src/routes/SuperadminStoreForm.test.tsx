import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminStoreForm from "./SuperadminStoreForm";
import { ApiError } from "../lib/api";
import { renderRouteWithGuard, signInAs } from "../test/renderRoute";

// Superadmin → Add / edit store. It had no tests. Pinned: superadmin
// only; create sends the store + first login and returns to the list
// without asking; a refusal lands on its field and keeps the form;
// an edit loads clean, and leaving it edited asks first.

const useSuperadminStore = vi.fn();
const createSuperadminStore = vi.fn();
const updateSuperadminStore = vi.fn();

vi.mock("../api/superadmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/superadmin")>()),
  useSuperadminStore: (...a: unknown[]) => useSuperadminStore(...a),
  createSuperadminStore: (...a: unknown[]) => createSuperadminStore(...a),
  updateSuperadminStore: (...a: unknown[]) => updateSuperadminStore(...a),
}));

const STORE = {
  store: {
    id: 7, name: "Cambio Express", slug: "cambio", email: "", phone: "",
    address: "", plan: "basic", business_type: "msb_hybrid", federal_tax_rate: 0.01,
  },
};

beforeEach(() => {
  signInAs({ role: "superadmin", store_id: null });
  useSuperadminStore.mockReturnValue({
    data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn(),
  });
  createSuperadminStore.mockReset().mockResolvedValue({});
  updateSuperadminStore.mockReset().mockResolvedValue({});
});

function renderNew() {
  return renderRouteWithGuard(<SuperadminStoreForm />, { path: "/superadmin/stores/new" });
}
function renderEdit() {
  useSuperadminStore.mockReturnValue({
    data: STORE, isLoading: false, isError: false, error: null, refetch: vi.fn(),
  });
  return renderRouteWithGuard(<SuperadminStoreForm />, {
    path: "/superadmin/stores/:id/edit", at: "/superadmin/stores/7/edit",
  });
}

async function fillNew(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Business name/), "North Shop");
  await user.type(screen.getByLabelText(/^URL slug/), "north");
  await user.type(screen.getByLabelText(/^Admin password/), "s3cret-pass");
}

describe("SuperadminStoreForm", () => {
  it("is closed to anyone but a superadmin", () => {
    signInAs({ role: "admin" });
    renderNew();
    expect(screen.getByText("Superadmin scope required.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create store" })).toBeNull();
  });

  it("creates the store with its first login and returns to the list without asking", async () => {
    const user = userEvent.setup();
    renderNew();
    await fillNew(user);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create store" }));
    await waitFor(() => expect(createSuperadminStore).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "North Shop", slug: "north", admin_username: "admin",
        admin_password: "s3cret-pass", initial_role: "admin",
      }),
    ));
    expect(await screen.findByText("Navigated to /superadmin/stores")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull();
  });

  it("puts a refused field's reason on the field and keeps the form", async () => {
    createSuperadminStore.mockRejectedValue(new ApiError(409, "taken", {
      detail: { field: "slug", message: "That slug is taken." },
    }));
    const user = userEvent.setup();
    renderNew();
    await fillNew(user);
    await user.click(screen.getByRole("button", { name: "Create store" }));
    expect(await screen.findByText("That slug is taken.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^URL slug/)).toHaveValue("north");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("an edit loads clean and saves the changed fields", async () => {
    const user = userEvent.setup();
    renderEdit();
    expect(screen.getByLabelText(/^Business name/)).toHaveValue("Cambio Express");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Plan"), "pro");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateSuperadminStore).toHaveBeenCalledWith(
      7, expect.objectContaining({ plan: "pro", slug: "cambio" }),
    ));
    expect(await screen.findByText("Store updated.")).toBeInTheDocument();
  });

  it("asks before Back or the sidebar leaves an edited store", async () => {
    const user = userEvent.setup();
    const { router } = renderEdit();
    await user.selectOptions(screen.getByLabelText("Plan"), "pro");
    await user.click(screen.getByRole("button", { name: "← Back to stores" }));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Plan")).toHaveValue("pro");

    act(() => { void router.navigate("/superadmin"); });
    await user.click(await screen.findByRole("button", { name: "Leave" }));
    expect(await screen.findByText("Navigated to /superadmin")).toBeInTheDocument();
  });
});
