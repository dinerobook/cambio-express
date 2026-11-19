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

// The store's department setup (Account → Departments, and the Price
// book's Departments tab). Pinned: the empty catalog offers a starter
// set (created in the reader's language, since the names become the
// store's own); a department deactivates rather than deletes; a
// refused save shows inside the popup; the Modisoft-style setup
// fields (register number, type, tax, age, NACS) are sent as typed;
// a register number already held by another department is caught at
// the field; the list searches by name and number and filters by type.

const createDepartment = vi.fn();
const updateDepartment = vi.fn();
let departments: unknown[] = [];

vi.mock("../api/dayclose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/dayclose")>()),
  useDepartments: () => ({ data: { departments }, isLoading: false, isError: false, refetch: vi.fn() }),
  createDepartment: (...a: unknown[]) => createDepartment(...a),
  updateDepartment: (...a: unknown[]) => updateDepartment(...a),
}));

const BASE = {
  parent_id: null, parent_name: "", sort_order: 10, is_active: true,
  department_type: "merchandise", is_taxable: true, min_age: null,
  nacs_code: "", pos_codes: [] as string[],
};
const TOBACCO = { ...BASE, id: 4, name: "Tobacco", min_age: 21, nacs_code: "400", pos_codes: ["9"] };
const LOTTERY = {
  ...BASE, id: 7, name: "LOTTERY", department_type: "lottery_sell",
  is_taxable: false, min_age: 18, nacs_code: "510", pos_codes: ["14"],
};

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

async function openAdd() {
  await userEvent.click(screen.getByRole("button", { name: "+ Add department" }));
  return screen.findByRole("dialog", { name: "Add a department" });
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
    expect(createDepartment).toHaveBeenNthCalledWith(7, {
      name: "Lottery", sort_order: 70,
      department_type: "lottery_sell", is_taxable: false, min_age: 18,
    });
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
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Tobacco");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add department" }));
    expect(await within(dialog).findByText("That name is taken.")).toBeInTheDocument();
  });

  it("lists the setup fields like the register has them", () => {
    departments = [TOBACCO, LOTTERY];
    renderManager();
    expect(screen.getAllByRole("columnheader").map((h) => (h.textContent ?? "").replace(/[↕▲▼]/g, ""))).toEqual(
      ["POS no", "Department", "Type", "Tax", "Min age", "NACS", "Status", "Actions"],
    );
    const lottery = screen.getByText("LOTTERY").closest("tr")!;
    expect(within(lottery).getByText("14")).toBeInTheDocument();
    expect(within(lottery).getByText("Lottery sales")).toBeInTheDocument();
    expect(within(lottery).getByText("Non-taxable")).toBeInTheDocument();
    expect(within(lottery).getByText("18+")).toBeInTheDocument();
    expect(screen.getByText("2 departments")).toBeInTheDocument();
  });

  it("searches by name or register number and filters by type", async () => {
    departments = [TOBACCO, LOTTERY];
    renderManager();
    const search = screen.getByRole("searchbox", { name: "Search departments" });
    await userEvent.type(search, "14");
    expect(screen.queryByText("Tobacco")).not.toBeInTheDocument();
    expect(screen.getByText("LOTTERY")).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter by type" }), "merchandise");
    expect(screen.getByText("Tobacco")).toBeInTheDocument();
    expect(screen.queryByText("LOTTERY")).not.toBeInTheDocument();
    expect(screen.getByText("1 department")).toBeInTheDocument();
  });

  it("creates a department with its register number, type, tax and age", async () => {
    departments = [TOBACCO];
    renderManager();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("Name"), "LOTTO");
    await userEvent.type(within(dialog).getByLabelText(/^POS dept no/), "13");
    const taxable = within(dialog).getByRole("checkbox", { name: "Taxable (sales tax applies)" });
    expect(taxable).toBeChecked();
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Type/), "lotto_sell");
    // A new lotto department follows its type: not taxable.
    expect(taxable).not.toBeChecked();
    expect(within(dialog).getByText("Lotto (draw game) tickets sold.")).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText("Minimum age"), "18");
    await userEvent.type(within(dialog).getByLabelText(/^NACS product code/), "510");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add department" }));
    await waitFor(() => expect(createDepartment).toHaveBeenCalledWith({
      name: "LOTTO", sort_order: 0, department_type: "lotto_sell",
      is_taxable: false, nacs_code: "510", pos_codes: ["13"],
      parent_id: null, min_age: 18,
    }));
  });

  it("catches a register number another department already has", async () => {
    departments = [TOBACCO];
    renderManager();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("Name"), "CIGAR");
    await userEvent.type(within(dialog).getByLabelText(/^POS dept no/), "3, 9");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add department" }));
    expect(await within(dialog).findByText("9 already belongs to Tobacco.")).toBeInTheDocument();
    expect(createDepartment).not.toHaveBeenCalled();
  });

  it("puts the server's register-number refusal under that field", async () => {
    // Another person tied the number to a department after this list
    // loaded: the server's 409 lands on the field, not in a banner.
    createDepartment.mockRejectedValue(
      new ApiError(409, "POS dept no 3 already belongs to 'CIGAR'.", null),
    );
    departments = [TOBACCO];
    renderManager();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("Name"), "CIGAR 2");
    await userEvent.type(within(dialog).getByLabelText(/^POS dept no/), "3");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add department" }));
    expect(await within(dialog).findByText(/already belongs to 'CIGAR'/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("saves an edit as the complete register-number list and clears the age", async () => {
    departments = [TOBACCO];
    renderManager();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Tobacco" });
    const pos = within(dialog).getByLabelText(/^POS dept no/);
    expect(pos).toHaveValue("9");
    await userEvent.type(pos, ", 27");
    await userEvent.selectOptions(within(dialog).getByLabelText("Minimum age"), "");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDepartment).toHaveBeenCalledWith(4, {
      name: "Tobacco", sort_order: 10, department_type: "merchandise",
      is_taxable: true, nacs_code: "400", pos_codes: ["9", "27"],
      parent_id: 0, min_age: 0,
    }));
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
    expect(screen.getAllByRole("columnheader").map((h) => (h.textContent ?? "").replace(/[↕▲▼]/g, ""))).toEqual(
      ["N.º POS", "Departamento", "Tipo", "Impuesto", "Edad mín.", "NACS", "Estado", "Acciones"],
    );
    expect(screen.getByText("activo")).toBeInTheDocument();
    const row = screen.getByText("Tobacco").closest("tr")!;
    expect(within(row).getByText("Mercancía")).toBeInTheDocument();
    expect(within(row).getByText("Gravable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog", { name: "Editar Tobacco" });
    expect(within(dialog).getByLabelText(/^Departamento principal/)).toHaveDisplayValue("Ninguno (principal)");
    expect(within(dialog).getByLabelText("Edad mínima")).toHaveDisplayValue("21+");
    expect(englishLeftovers(dialog, ["dept."])).toEqual([]);
  });
});
