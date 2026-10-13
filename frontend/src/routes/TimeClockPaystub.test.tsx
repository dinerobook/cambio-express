import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import TimeClockPaystub from "./TimeClockPaystub";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// The printable paystub: approved hours x rate = gross pay. The
// numbers on it are what a cashier is paid, so pin that they are the
// server's, that the period comes from the URL, and that a refused or
// failed load never renders a blank (or stale) stub.

const PAYSTUB = {
  store_employee_id: 3, employee_name: "Ana Pérez", hourly_rate: 15,
  approved_hours: 8.5, gross_pay: 127.5,
  from_date: "2026-10-01", to_date: "2026-10-15",
  shifts: [{
    id: 41, clock_in_at: "2026-10-09T15:00:00", clock_out_at: "2026-10-09T23:30:00",
    hours_worked: 8.5, status: "approved", notes: "",
  }],
};
const PATH = "/admin/timeclock/paystub/:id";
const AT = "/admin/timeclock/paystub/3?from=2026-10-01&to=2026-10-15";

function routes(extra: Record<string, MockHandler> = {}) {
  return {
    "GET /api/v2/admin/store-info": { body: { store: { name: "Cambio Uno" } } },
    "GET /api/v2/admin/timeclock/paystub/3": { body: PAYSTUB },
    ...extra,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("Paystub", () => {
  it("renders the server's hours, rate and gross pay for the URL's period", async () => {
    const calls = mockFetch(routes());
    renderRoute(<TimeClockPaystub />, { path: PATH, at: AT });
    expect(await screen.findByText("Ana Pérez")).toBeInTheDocument();
    expect(screen.getByText("$127.50")).toBeInTheDocument();
    expect(screen.getByText("$15.00")).toBeInTheDocument();
    expect(screen.getAllByText("8.50").length).toBeGreaterThan(0);
    expect(screen.getByText("approved", { selector: "span" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Cambio Uno · pay period 2026-10-01/)).toBeInTheDocument());
    expect(callsTo(calls, "GET /api/v2/admin/timeclock/paystub/3")[0].path)
      .toBe("/api/v2/admin/timeclock/paystub/3?from=2026-10-01&to=2026-10-15");
  });

  it("shows a dash, not $0.00, when no hourly rate is set", async () => {
    mockFetch(routes({
      "GET /api/v2/admin/timeclock/paystub/3": {
        body: { ...PAYSTUB, hourly_rate: 0, gross_pay: 0, shifts: [] },
      },
    }));
    renderRoute(<TimeClockPaystub />, { path: PATH, at: AT });
    expect(await screen.findByText("No shifts in this window.")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("refuses an employee without loading anyone's pay", async () => {
    signInAs({ role: "employee" });
    mockFetch(routes());
    renderRoute(<TimeClockPaystub />, { path: PATH, at: AT });
    expect(screen.getByText("Admin or owner only.")).toBeInTheDocument();
    expect(screen.queryByText("Ana Pérez")).not.toBeInTheDocument();
  });

  it("asks for the pay period when the link has none", () => {
    const calls = mockFetch(routes());
    renderRoute(<TimeClockPaystub />, { path: PATH, at: "/admin/timeclock/paystub/3" });
    expect(screen.getByText(/missing its pay period/)).toBeInTheDocument();
    expect(callsTo(calls, "GET /api/v2/admin/timeclock/paystub/3")).toHaveLength(0);
  });

  it("shows the server's refusal (403) with a retry", async () => {
    mockFetch(routes({
      "GET /api/v2/admin/timeclock/paystub/3": {
        status: 403, body: { detail: "That roster member is in another store." },
      },
    }));
    renderRoute(<TimeClockPaystub />, { path: PATH, at: AT });
    expect(await screen.findByText("That roster member is in another store.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("recovers on retry after a failed load", async () => {
    let fail = true;
    mockFetch(routes({
      "GET /api/v2/admin/timeclock/paystub/3": () => (fail
        ? { status: 500, body: {} }
        : { body: PAYSTUB }),
    }));
    renderRoute(<TimeClockPaystub />, { path: PATH, at: AT });
    expect(await screen.findByText("Request failed (500)")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Ana Pérez")).toBeInTheDocument();
  });
});
