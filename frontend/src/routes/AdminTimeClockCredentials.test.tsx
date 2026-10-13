import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminTimeClockCredentials from "./AdminTimeClockCredentials";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// Passkey enrollment for the time clock. Once the store's gate is on,
// a cashier without a registered passkey cannot clock in, so the
// list must say who is ready, enrolment must send the browser's
// credential to the server, and a refused enrol/remove must say why.

const webauthn = vi.hoisted(() => ({
  supported: true,
  register: vi.fn(),
}));
vi.mock("../lib/webauthn", () => ({
  passkeysSupported: () => webauthn.supported,
  performPasskeyRegister: (...a: unknown[]) => webauthn.register(...a),
  performPasskeyAssert: vi.fn(),
}));

const ROWS = [
  { store_employee_id: 3, employee_name: "Ana", has_passkey: true, name: "Ana",
    registered_at: "2026-10-01T15:00:00", last_used_at: "2026-10-09T15:00:00" },
  { store_employee_id: 4, employee_name: "Beto", has_passkey: false, name: "",
    registered_at: "", last_used_at: "" },
];

function routes(extra: Record<string, MockHandler> = {}) {
  return {
    "GET /api/v2/admin/store-info": { body: { store: { timeclock_require_passkey: true } } },
    "GET /api/v2/admin/timeclock/credentials": { body: { rows: ROWS } },
    ...extra,
  };
}

beforeEach(() => {
  webauthn.supported = true;
  webauthn.register.mockReset().mockResolvedValue({ id: "cred-1" });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("Time-clock credentials", () => {
  it("lists who is registered and who is pending, with the gate state", async () => {
    mockFetch(routes());
    renderRoute(<AdminTimeClockCredentials />);
    expect(await screen.findByText("Registered", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(await screen.findByText(/Passkey gate is currently/)).toBeInTheDocument();
    const beto = screen.getByText("Beto").closest("tr")!;
    expect(within(beto).getByRole("button", { name: "Enroll passkey" })).toBeInTheDocument();
    expect(within(beto).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    const ana = screen.getByText("Ana").closest("tr")!;
    expect(within(ana).getByRole("button", { name: "Re-enroll" })).toBeInTheDocument();
  });

  it("shows the empty state for a store with no roster", async () => {
    mockFetch(routes({ "GET /api/v2/admin/timeclock/credentials": { body: { rows: [] } } }));
    renderRoute(<AdminTimeClockCredentials />);
    expect(await screen.findByText("No active roster members yet.")).toBeInTheDocument();
  });

  it("shows nothing to an employee", () => {
    signInAs({ role: "employee" });
    mockFetch(routes());
    renderRoute(<AdminTimeClockCredentials />);
    expect(screen.getByText("Admin or owner only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enroll/ })).not.toBeInTheDocument();
  });

  it("disables enrolment when the browser has no WebAuthn", async () => {
    webauthn.supported = false;
    mockFetch(routes());
    renderRoute(<AdminTimeClockCredentials />);
    expect(await screen.findByRole("button", { name: "Enroll passkey" })).toBeDisabled();
    expect(screen.getByText(/doesn't expose the WebAuthn API/)).toBeInTheDocument();
  });

  it("enrols a passkey: begin, browser prompt, finish", async () => {
    const calls = mockFetch(routes({
      "POST /api/v2/admin/timeclock/credentials/4/register/begin": {
        body: { options_json: "{\"x\":1}", register_token: "tok-4" },
      },
      "POST /api/v2/admin/timeclock/credentials/4/register/finish": { body: ROWS[0] },
    }));
    renderRoute(<AdminTimeClockCredentials />);
    await userEvent.click(await screen.findByRole("button", { name: "Enroll passkey" }));
    await vi.waitFor(() => expect(
      callsTo(calls, "POST /api/v2/admin/timeclock/credentials/4/register/finish"),
    ).toHaveLength(1));
    expect(webauthn.register).toHaveBeenCalledWith("{\"x\":1}");
    expect(callsTo(calls, "POST /api/v2/admin/timeclock/credentials/4/register/finish")[0].body)
      .toEqual({ register_token: "tok-4", credential: { id: "cred-1" }, name: "Beto" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the server's reason when enrolment is refused", async () => {
    mockFetch(routes({
      "POST /api/v2/admin/timeclock/credentials/4/register/begin": {
        status: 403, body: { detail: "Only admins can enroll passkeys." },
      },
    }));
    renderRoute(<AdminTimeClockCredentials />);
    await userEvent.click(await screen.findByRole("button", { name: "Enroll passkey" }));
    expect(await screen.findByText("Only admins can enroll passkeys.")).toBeInTheDocument();
    expect(webauthn.register).not.toHaveBeenCalled();
  });

  it("removes a passkey after confirming", async () => {
    const calls = mockFetch(routes({
      "DELETE /api/v2/admin/timeclock/credentials/3": { status: 204 },
    }));
    renderRoute(<AdminTimeClockCredentials />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Remove Ana's registered passkey/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => expect(
      callsTo(calls, "DELETE /api/v2/admin/timeclock/credentials/3"),
    ).toHaveLength(1));
  });

  it("shows the error when removal fails", async () => {
    mockFetch(routes({
      "DELETE /api/v2/admin/timeclock/credentials/3": {
        status: 422, body: { detail: "Gate is on; enroll another first." },
      },
    }));
    renderRoute(<AdminTimeClockCredentials />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Gate is on; enroll another first.")).toBeInTheDocument();
  });

  it("offers a retry when the list fails to load", async () => {
    mockFetch(routes({ "GET /api/v2/admin/timeclock/credentials": { status: 500, body: {} } }));
    renderRoute(<AdminTimeClockCredentials />);
    expect(await screen.findByText("Couldn't load roster credentials.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
