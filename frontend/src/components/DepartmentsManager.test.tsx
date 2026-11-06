import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DepartmentsManager from "./DepartmentsManager";
import { ToastProvider } from "./ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// The store's department catalog (Price book → Departments). It had
// no tests. Pinned: the empty catalog offers a starter set (created
// in the reader's language, since the names become the store's own),
// a department deactivates rather than deletes, and a refused save
// shows inside the popup.

const createDepartment = vi.fn();
const updateDepartment = vi.fn();
let departments: unknown[] = [];

vi.mock("../api/dayclose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/dayclose")>()),
  useDepartments: () => ({ data: { departments }, isLoading: false, isError: false, refetch: vi.fn() }),
  createDepartment: (...a: unknown[]) => createDepartment(...a),
  updateDepartment: (...a: unknown[]) => updateDepartment(...a),
}));

const TOBACCO = { id: 4, name: "Tobacco", parent_id: null, parent_name: "", sort_order: 10, is_active: true };

function renderManager() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DepartmentsManager />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setCurrentIdentity(TEST_ADMIN);
  createDepartment.mockReset().mockResolvedValue({});
  updateDepartment.mockReset().mockResolvedValue({});
  departments = [];
});

describe("<DepartmentsManager>", () => {
  it("adds the starter set on an empty catalog, in order", async () => {
    renderManager();
    await userEvent.click(screen.getByRole("button", { name: "Add starter departments" }));
    await waitFor(() => expect(createDepartment).toHaveBeenCalledTimes(8));
    expect(createDepartment).toHaveBeenNthCalledWith(1, { name: "Grocery", sort_order: 10 });
    expect(createDepartment).toHaveBeenLastCalledWith({ name: "Other", sort_order: 80 });
  });

  it("deactivates a department instead of deleting it", async () => {
    departments = [TOBACCO];
    renderManager();
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(updateDepartment).toHaveBeenCalledWith(4, { is_active: false }));
  });

  it("shows a refused save inside the popup", async () => {
    createDepartment.mockRejectedValue(new ApiError(409, "That name is taken.", null));
    departments = [TOBACCO];
    renderManager();
    await userEvent.click(screen.getByRole("button", { name: "+ Add department" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a department" });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Tobacco");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add department" }));
    expect(await within(dialog).findByText("That name is taken.")).toBeInTheDocument();
  });

  it("reads in Spanish, and creates the starter set in Spanish", async () => {
    setLanguage("es");
    const { unmount } = renderManager();
    expect(screen.getByText("Todavía no hay departamentos")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["dept."])).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Agregar departamentos iniciales" }));
    await waitFor(() => expect(createDepartment).toHaveBeenCalledTimes(8));
    expect(createDepartment).toHaveBeenNthCalledWith(1, { name: "Abarrotes", sort_order: 10 });
    unmount();

    departments = [TOBACCO];
    renderManager();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(["Departamento", "Principal", "Orden", "Estado", "Acciones"]);
    expect(screen.getByText("activo")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog", { name: "Editar Tobacco" });
    expect(within(dialog).getByLabelText(/^Departamento principal/)).toHaveDisplayValue("Ninguno (principal)");
    expect(englishLeftovers(dialog, ["dept."])).toEqual([]);
  });
});
