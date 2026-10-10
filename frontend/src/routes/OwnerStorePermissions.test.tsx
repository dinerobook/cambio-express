import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import OwnerStorePermissions from "./OwnerStorePermissions";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";

// An owner edits one store's role matrix — a privilege-escalation
// surface (Auth INVARIANTS). Pinned: non-editable roles render
// disabled and are never sent; the PUT body carries only editable
// roles; Save is disabled until something changes; refusals show.

const api = vi.fn();

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return { ...real, api: (...a: unknown[]) => api(...a) };
});

function matrix(overrides: string[] = []) {
  return {
    store_id: 7,
    roles: ["admin", "employee"],
    editable_roles: ["employee"],
    resources: ["transfers"],
    actions: ["create", "read", "update", "delete"],
    matrix: {
      admin: { transfers: { create: true, read: true, update: true, delete: true } },
      employee: { transfers: { create: false, read: true, update: false, delete: false } },
    },
    has_overrides: overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/owner/store/7/permissions"]}>
          <Routes>
            <Route path="/owner/store/:storeId/permissions" element={<OwnerStorePermissions />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const cell = (action: string, role: string) =>
  screen.getByRole("checkbox", { name: `${action} — Money transfers (${role})` });

describe("OwnerStorePermissions", () => {
  beforeEach(() => {
    api.mockReset();
  });

  it("loads the store's matrix and locks the non-editable role", async () => {
    api.mockResolvedValue(matrix());
    renderPage();
    await waitFor(() => expect(cell("Create", "admin")).toBeChecked());
    expect(api).toHaveBeenCalledWith("/api/v2/owner/store/7/permissions");
    expect(cell("Create", "admin")).toBeDisabled();
    expect(cell("Create", "employee")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save permissions" })).toBeDisabled();
  });

  it("shows the load error", async () => {
    api.mockRejectedValue(new ApiError(403, "Not your store.", null));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Not your store.");
  });

  it("saves only the editable roles", async () => {
    const saved = matrix(["employee"]);
    saved.matrix.employee.transfers.create = true;
    api.mockImplementation(async (_url: string, opts?: { method?: string }) =>
      opts?.method === "PUT" ? saved : matrix());
    renderPage();
    await waitFor(() => expect(cell("Create", "employee")).toBeEnabled());
    await userEvent.click(cell("Create", "employee"));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith(
      "/api/v2/owner/store/7/permissions",
      {
        method: "PUT",
        json: {
          matrix: {
            employee: { transfers: { create: true, read: true, update: false, delete: false } },
          },
        },
      },
    ));
    expect(await screen.findByText("Permissions updated.")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("keeps the draft and shows the refusal when Save is refused", async () => {
    api.mockImplementation(async (_url: string, opts?: { method?: string }) => {
      if (opts?.method === "PUT") throw new ApiError(403, "You can't grant what you don't hold.", null);
      return matrix();
    });
    renderPage();
    await waitFor(() => expect(cell("Create", "employee")).toBeEnabled());
    await userEvent.click(cell("Create", "employee"));
    await userEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You can't grant what you don't hold.");
    expect(cell("Create", "employee")).toBeChecked();
  });

  it("Reset discards the local draft", async () => {
    api.mockResolvedValue(matrix());
    renderPage();
    await waitFor(() => expect(cell("Create", "employee")).toBeEnabled());
    await userEvent.click(cell("Create", "employee"));
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(cell("Create", "employee")).not.toBeChecked();
  });

  it("resets a customized role to the global defaults", async () => {
    api.mockImplementation(async (_url: string, opts?: { method?: string }) =>
      opts?.method === "POST" ? matrix() : matrix(["employee"]));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith(
      "/api/v2/owner/store/7/permissions/reset",
      { method: "POST", json: { role: "employee" } },
    ));
    expect(await screen.findByText("Employee permissions reset to defaults.")).toBeInTheDocument();
  });
});
