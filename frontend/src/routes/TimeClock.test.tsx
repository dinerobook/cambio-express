import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import TimeClock from "./TimeClock";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute } from "../test/renderRoute";

// The punch page. Every shift's hours start here, so a punch that
// silently fails (or looks recorded when it was refused) is lost
// pay. Pinned: the roster + open shifts render, the button follows
// the picked person's state, a refused punch shows the server's
// reason, and a failed load offers a retry.

const webauthn = vi.hoisted(() => ({ supported: true, assert: vi.fn() }));
vi.mock("../lib/webauthn", () => ({
  passkeysSupported: () => webauthn.supported,
  performPasskeyAssert: (...a: unknown[]) => webauthn.assert(...a),
  performPasskeyRegister: vi.fn(),
}));

const ROSTER = { employees: [{ id: 3, name: "Ana" }, { id: 4, name: "Beto" }] };
const OPEN_ANA = {
  id: 41, store_employee_id: 3, employee_name: "Ana",
  clock_in_at: "2026-10-09T15:00:00", clock_out_at: null, hours_worked: null,
  notes: "covering", status: "pending", adjusted: false,
  break_started_at: null, break_minutes: 0, late_minutes: null,
};
const STORE = { store: { timeclock_require_passkey: false, timeclock_require_geofence: false } };

function routes(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    "GET /api/v2/transfers/employees": { body: ROSTER },
    "GET /api/v2/timeclock/status": { body: { open_entries: [OPEN_ANA] } },
    "GET /api/v2/admin/store-info": { body: STORE },
    ...extra,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

async function pick(name: string) {
  const select = await screen.findByRole("combobox", { name: /Roster name/ });
  const option = screen.getAllByRole("option").find((o) => o.textContent?.startsWith(name));
  await userEvent.selectOptions(select, option!);
}

describe("Time clock punch page", () => {
  it("lists the roster and who is on the clock", async () => {
    mockFetch(routes());
    renderRoute(<TimeClock />);
    expect(await screen.findByRole("option", { name: /Ana\s+\(clocked in\)/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Beto" })).toBeInTheDocument();
    expect(await screen.findByText("covering")).toBeInTheDocument();
  });

  it("shows the empty state when nobody is clocked in", async () => {
    mockFetch(routes({ "GET /api/v2/timeclock/status": { body: { open_entries: [] } } }));
    renderRoute(<TimeClock />);
    expect(await screen.findByText("Nobody's on the clock right now.")).toBeInTheDocument();
  });

  it("clocks a person in and says so", async () => {
    const calls = mockFetch(routes({
      "POST /api/v2/timeclock/clock-in": { body: { entry: { ...OPEN_ANA, id: 42, store_employee_id: 4 } } },
    }));
    renderRoute(<TimeClock />);
    await pick("Beto");
    expect(screen.queryByRole("button", { name: "Start break" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "early");
    await userEvent.click(screen.getByRole("button", { name: "Clock in" }));
    expect(await screen.findByText("Beto clocked in.")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/timeclock/clock-in")[0].body).toEqual({
      store_employee_id: 4, notes: "early",
    });
  });

  it("offers Clock out and a break for someone already on the clock", async () => {
    const calls = mockFetch(routes({
      "POST /api/v2/timeclock/clock-out": { body: { entry: OPEN_ANA } },
      "POST /api/v2/timeclock/break/start": { body: { entry: OPEN_ANA } },
    }));
    renderRoute(<TimeClock />);
    await pick("Ana");
    await userEvent.click(screen.getByRole("button", { name: "Start break" }));
    expect(await screen.findByText("Break started.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clock out" }));
    expect(await screen.findByText("Ana clocked out.")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/timeclock/clock-in")).toHaveLength(0);
    expect(callsTo(calls, "POST /api/v2/timeclock/clock-out")[0].body)
      .toMatchObject({ store_employee_id: 3 });
  });

  it("shows the server's reason when a punch is refused", async () => {
    mockFetch(routes({
      "POST /api/v2/timeclock/clock-in": {
        status: 422, body: { detail: "Outside business hours." },
      },
    }));
    renderRoute(<TimeClock />);
    await pick("Beto");
    await userEvent.click(screen.getByRole("button", { name: "Clock in" }));
    expect(await screen.findByText("Outside business hours.")).toBeInTheDocument();
    expect(screen.queryByText("Beto clocked in.")).not.toBeInTheDocument();
  });

  it("shows a refused (403) break change", async () => {
    mockFetch(routes({
      "POST /api/v2/timeclock/break/start": { status: 403, body: { detail: "Not your shift." } },
    }));
    renderRoute(<TimeClock />);
    await pick("Ana");
    await userEvent.click(screen.getByRole("button", { name: "Start break" }));
    expect(await screen.findByText("Not your shift.")).toBeInTheDocument();
  });

  it("runs the passkey prompt first when the store requires one", async () => {
    webauthn.supported = true;
    webauthn.assert.mockReset().mockResolvedValue({ id: "a1" });
    const calls = mockFetch(routes({
      "GET /api/v2/admin/store-info": { body: { store: { timeclock_require_passkey: true } } },
      "POST /api/v2/timeclock/passkey/challenge": {
        body: { options_json: "{}", assert_token: "assert-4" },
      },
      "POST /api/v2/timeclock/clock-in": { body: { entry: OPEN_ANA } },
    }));
    renderRoute(<TimeClock />);
    await pick("Beto");
    await waitFor(() => expect(callsTo(calls, "GET /api/v2/admin/store-info")).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Clock in" }));
    expect(await screen.findByText("Beto clocked in.")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/timeclock/clock-in")[0].body).toEqual({
      store_employee_id: 4, notes: "", assert_token: "assert-4", assertion: { id: "a1" },
    });
  });

  it("refuses to punch without WebAuthn when the store requires a passkey", async () => {
    webauthn.supported = false;
    const calls = mockFetch(routes({
      "GET /api/v2/admin/store-info": { body: { store: { timeclock_require_passkey: true } } },
    }));
    renderRoute(<TimeClock />);
    await pick("Beto");
    await waitFor(() => expect(callsTo(calls, "GET /api/v2/admin/store-info")).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Clock in" }));
    expect(await screen.findByText(/requires a passkey for time-clock punches/)).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/timeclock/clock-in")).toHaveLength(0);
  });

  it("offers a retry when the roster fails to load", async () => {
    let fail = true;
    mockFetch(routes({
      "GET /api/v2/transfers/employees": () => (fail
        ? { status: 500, body: { detail: "boom" } }
        : { body: ROSTER }),
    }));
    renderRoute(<TimeClock />);
    expect(await screen.findByText("Couldn't load the store roster.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Beto" })).toBeInTheDocument());
  });

  it("offers a retry when the open shifts fail to load", async () => {
    mockFetch(routes({ "GET /api/v2/timeclock/status": { status: 500, body: {} } }));
    renderRoute(<TimeClock />);
    expect(await screen.findByText("Couldn't load current shifts.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
