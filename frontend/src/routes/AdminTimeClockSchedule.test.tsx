import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminTimeClockSchedule from "./AdminTimeClockSchedule";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";

// A week whose shifts failed to load must say so (with Retry), not
// render seven empty "No shifts" columns that invite the admin to
// plan the week a second time.

const useShifts = vi.fn();
const refetch = vi.fn();
const createShift = vi.fn();

vi.mock("../api/timeclock", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/timeclock")>();
  return {
    ...real,
    useShifts: () => useShifts(),
    createShift: (...a: unknown[]) => createShift(...a),
  };
});
vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return {
    ...real,
    useEmployees: () => ({
      data: { employees: [{ id: 1, name: "Ana" }] },
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
  };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter><AdminTimeClockSchedule /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  refetch.mockReset();
  createShift.mockReset();
});

describe("AdminTimeClockSchedule", () => {
  it("shows an error with Retry when the week's shifts fail to load", async () => {
    useShifts.mockReturnValue({
      data: undefined, isLoading: false, isError: true, isFetching: false,
      refetch,
    });
    renderPage();
    expect(screen.getByRole("alert"))
      .toHaveTextContent("Couldn't load this week's shifts.");
    expect(screen.queryByText("No shifts")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Add shift" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("shows the empty week when the load succeeds with no shifts", () => {
    useShifts.mockReturnValue({
      data: { rows: [] }, isLoading: false, isError: false, isFetching: false,
      refetch,
    });
    renderPage();
    expect(screen.getAllByText("No shifts")).toHaveLength(7);
  });

  describe("planning a shift", () => {
    beforeEach(() => {
      useShifts.mockReturnValue({
        data: { rows: [] }, isLoading: false, isError: false, isFetching: false,
        refetch,
      });
    });

    async function openFirstDay(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getAllByRole("button", { name: "+ Add shift" })[0]);
    }

    it("schedules a cashier and closes the form", async () => {
      createShift.mockResolvedValue({ employee_name: "Ana" });
      const user = userEvent.setup();
      renderPage();
      await openFirstDay(user);
      await user.selectOptions(screen.getByLabelText("Cashier"), "1");
      await user.click(screen.getByRole("button", { name: "Add" }));
      expect(createShift).toHaveBeenCalledWith(expect.objectContaining({
        store_employee_id: 1, start_time: "09:00", end_time: "17:00", notes: "",
      }));
      expect(await screen.findByText("Scheduled Ana.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Cashier")).not.toBeInTheDocument();
    });

    it("keeps the form when the save is refused", async () => {
      createShift.mockRejectedValue(new ApiError(409, "Ana already works then.", null));
      const user = userEvent.setup();
      renderPage();
      await openFirstDay(user);
      await user.selectOptions(screen.getByLabelText("Cashier"), "1");
      await user.click(screen.getByRole("button", { name: "Add" }));
      expect(await screen.findByText("Ana already works then.")).toBeInTheDocument();
      expect(screen.getByLabelText("Cashier")).toHaveValue("1");
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });

    it("asks before Cancel drops a filled-in shift; an untouched one closes at once", async () => {
      const user = userEvent.setup();
      renderPage();
      await openFirstDay(user);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByLabelText("Cashier")).not.toBeInTheDocument();

      await openFirstDay(user);
      await user.selectOptions(screen.getByLabelText("Cashier"), "1");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(await screen.findByRole("button", { name: "Keep editing" }));
      expect(screen.getByLabelText("Cashier")).toHaveValue("1");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(await screen.findByRole("button", { name: "Leave" }));
      expect(screen.queryByLabelText("Cashier")).not.toBeInTheDocument();
    });
  });
});
