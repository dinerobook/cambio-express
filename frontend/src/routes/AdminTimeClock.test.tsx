import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminTimeClock from "./AdminTimeClock";
import { ToastProvider } from "../components/ui/Toast";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { setDisplayTimezone } from "../lib/datetime";
import { TEST_ADMIN } from "../test/setup";

// Payroll history shows and edits punches on the STORE's clock. The
// server stores naive UTC: a 10:00 clock-in in Chicago is
// "2026-10-09T15:00:00". Before, the list read that as local time and
// the edit form saved it back shifted by the UTC offset, so every
// "Save changes" moved the punch by 5 hours.

const adminCreateEntry = vi.fn();
const adminUpdateEntry = vi.fn();

const ROW = {
  id: 41, store_employee_id: 3, employee_name: "Ana",
  clock_in_at: "2026-10-09T15:00:00", clock_out_at: "2026-10-09T23:30:00",
  hours_worked: 8.5, notes: "", status: "pending", adjusted: false,
  break_started_at: null, break_minutes: 0, late_minutes: null,
};
const LIST = {
  data: {
    rows: [ROW], total_hours: 8.5, approved_hours: 0, pending_hours: 8.5,
    late_threshold_minutes: 5,
  },
  isLoading: false, isError: false,
};

vi.mock("../api/timeclock", () => ({
  useAdminTimeClock: () => LIST,
  useTimeClockHistory: () => ({ data: undefined, isLoading: true }),
  adminCreateEntry: (...a: unknown[]) => adminCreateEntry(...a),
  adminUpdateEntry: (...a: unknown[]) => adminUpdateEntry(...a),
  adminDeleteEntry: vi.fn(),
}));
vi.mock("../api/transfers", () => ({
  useEmployees: () => ({ data: { employees: [{ id: 3, name: "Ana" }] } }),
}));
vi.mock("../api/account", () => ({
  useStoreInfo: () => ({ data: { store: { timeclock_late_minutes_threshold: 5 } } }),
  updateStoreInfo: vi.fn(),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter><AdminTimeClock /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function input(dialog: HTMLElement, label: RegExp): HTMLInputElement {
  return within(dialog).getByLabelText(label) as HTMLInputElement;
}

beforeEach(() => {
  setDisplayTimezone("America/Chicago");
  adminCreateEntry.mockReset().mockResolvedValue({});
  adminUpdateEntry.mockReset().mockResolvedValue({});
});

describe("Payroll history on the store clock", () => {
  it("lists punches in the store's timezone", () => {
    renderPage();
    expect(screen.getByText("Oct 9, 2026, 10:00 CDT")).toBeInTheDocument();
    expect(screen.getByText("Oct 9, 2026, 18:30 CDT")).toBeInTheDocument();
  });

  it("prefills the edit form on the store clock and saves the same instant", async () => {
    renderPage();
    await userEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(input(dialog, /^Clock in/).value).toBe("2026-10-09T10:00");
    expect(input(dialog, /^Clock out/).value).toBe("2026-10-09T18:30");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(adminUpdateEntry).toHaveBeenCalledWith(41, expect.objectContaining({
      clock_in_at: "2026-10-09T15:00:00.000Z",
      clock_out_at: "2026-10-09T23:30:00.000Z",
    })));
  });

  it("reads a back-filled punch as store time", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /New entry/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(input(dialog, /^Clock in/), "2026-10-08T09:15");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create entry" }));
    await waitFor(() => expect(adminCreateEntry).toHaveBeenCalledWith(expect.objectContaining({
      store_employee_id: 3,
      clock_in_at: "2026-10-08T14:15:00.000Z",
      clock_out_at: null,
    })));
  });

  it("keeps the form open with the server's message when a save fails", async () => {
    adminUpdateEntry.mockRejectedValue(
      new ApiError(422, "Clock out must be after clock in.", {}),
    );
    renderPage();
    await userEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText("Clock out must be after clock in."))
      .toBeInTheDocument();
  });

  it("shows nothing to an employee", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "employee" });
    renderPage();
    expect(screen.getByText("Admin or owner only.")).toBeInTheDocument();
    expect(screen.queryByText("Oct 9, 2026, 10:00 CDT")).not.toBeInTheDocument();
  });
});
