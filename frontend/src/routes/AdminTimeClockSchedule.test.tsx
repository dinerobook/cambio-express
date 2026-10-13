import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminTimeClockSchedule from "./AdminTimeClockSchedule";
import { ToastProvider } from "../components/ui";

// A week whose shifts failed to load must say so (with Retry), not
// render seven empty "No shifts" columns that invite the admin to
// plan the week a second time.

const useShifts = vi.fn();
const refetch = vi.fn();

vi.mock("../api/timeclock", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/timeclock")>();
  return { ...real, useShifts: () => useShifts() };
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
});
