import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EmployeeForm from "./EmployeeForm";
import { ApiError } from "../lib/api";
import { renderRouteWithGuard } from "../test/renderRoute";

// Team → Employee (add / edit). The page-level form had no tests.
// Pinned: create sends the profile and returns to the roster without
// asking; a blank name is caught before any call; a refusal keeps the
// form; the edit form loads clean; switching tabs keeps the draft and
// never asks (Save stores every tab at once); leaving edited asks.

const useEmployees = vi.fn();
const createEmployee = vi.fn();
const updateEmployee = vi.fn();

vi.mock("../api/employees", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/employees")>()),
  useEmployees: () => useEmployees(),
  createEmployee: (...a: unknown[]) => createEmployee(...a),
  updateEmployee: (...a: unknown[]) => updateEmployee(...a),
}));

const ANA = {
  id: 4, name: "Ana Ruiz", is_active: true, hourly_rate: 15,
  hired_on: "2026-01-05", date_of_birth: null, email: "", phone: "",
  address_line1: "", address_line2: "", payroll_schedule: "",
  user_id: null, username: null, role: null,
};

beforeEach(() => {
  useEmployees.mockReturnValue({
    data: { rows: [ANA], login_only: [] }, isLoading: false, isError: false,
    refetch: vi.fn(),
  });
  createEmployee.mockReset().mockResolvedValue({});
  updateEmployee.mockReset().mockResolvedValue({});
});

const renderNew = () =>
  renderRouteWithGuard(<EmployeeForm />, { path: "/employees/new" });
const renderEdit = () =>
  renderRouteWithGuard(<EmployeeForm />, { path: "/employees/:id/edit", at: "/employees/4/edit" });

describe("EmployeeForm", () => {
  it("creates an employee and returns to the roster without asking", async () => {
    const user = userEvent.setup();
    renderNew();
    await user.type(screen.getByLabelText(/^Full name/), "Luis Paz");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Employee" }));
    await waitFor(() => expect(createEmployee).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Luis Paz" }),
    ));
    expect(await screen.findByText("Navigated to /employees")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull();
  });

  it("catches a blank name before calling the server", async () => {
    const user = userEvent.setup();
    renderNew();
    await user.click(screen.getByRole("button", { name: "Create Employee" }));
    expect(await screen.findByText("Enter the employee's full name.")).toBeInTheDocument();
    expect(createEmployee).not.toHaveBeenCalled();
  });

  it("keeps the form and shows the refusal", async () => {
    updateEmployee.mockRejectedValue(new ApiError(403, "You can't edit this employee.", null));
    const user = userEvent.setup();
    renderEdit();
    await user.type(screen.getByLabelText(/^Full name/), " Jr");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(await screen.findByText("You can't edit this employee.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Full name/)).toHaveValue("Ana Ruiz Jr");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("loads an edit clean; a tab switch keeps the draft and does not ask", async () => {
    const user = userEvent.setup();
    const { router } = renderEdit();
    expect(screen.getByLabelText(/^Full name/)).toHaveValue("Ana Ruiz");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByText("Save Changes stores every tab at once.")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Full name/), " Jr");
    await user.click(screen.getByRole("tab", { name: "Payroll" }));
    expect(router.state.location.search).toBe("?tab=payroll");
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Profile" }));
    expect(screen.getByLabelText(/^Full name/)).toHaveValue("Ana Ruiz Jr");
  });

  it("asks before Cancel or the sidebar leaves an edited employee", async () => {
    const user = userEvent.setup();
    const { router } = renderEdit();
    await user.type(screen.getByLabelText(/^Full name/), " Jr");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    act(() => { void router.navigate("/dashboard"); });
    await user.click(await screen.findByRole("button", { name: "Leave" }));
    expect(await screen.findByText("Navigated to /dashboard")).toBeInTheDocument();
  });
});
