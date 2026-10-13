import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "./api";
import { getCurrentIdentity } from "./auth";

// What a 401 does in the API client.
//   - Ordinary endpoint: refresh silently and retry once; when the
//     refresh fails the session is dead → clear it, go to /app/login.
//   - Sign-in steps (/auth/login, /login/totp, /login/recovery, the
//     enrol steps, /login-cross-store): a 401 is "wrong password /
//     code". No refresh and no bounce — the page shows the error and
//     keeps its pending 2FA token.
//   - Time-clock punches: a failed passkey or geofence check is a
//     401 on a live session. Refresh + retry as usual, but a second
//     401 is the punch being refused, not a reason to sign out.

const json = (status: number, body: unknown) => new Response(
  JSON.stringify(body),
  { status, headers: { "Content-Type": "application/json" } },
);
const REFRESHED = {
  user_id: 1, username: "admin@test", full_name: "Test Admin",
  role: "admin", store_id: 1, permissions: [],
};

const assign = vi.fn();
const fetchMock = vi.fn();
const calls = () => fetchMock.mock.calls.map(([p]) => String(p));

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign, pathname: "/app/time-clock" },
  });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  assign.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api() on 401 — ordinary endpoint", () => {
  it("refreshes, retries once and returns the data", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { detail: "expired" }))
      .mockResolvedValueOnce(json(200, REFRESHED))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await expect(api("/api/v2/transfers")).resolves.toEqual({ ok: true });
    expect(calls()).toEqual([
      "/api/v2/transfers", "/api/v2/auth/refresh", "/api/v2/transfers",
    ]);
    expect(assign).not.toHaveBeenCalled();
  });

  it("signs out and goes to /app/login when the refresh fails", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { detail: "expired" }))
      .mockResolvedValueOnce(json(401, { detail: "refresh revoked" }));
    await expect(api("/api/v2/transfers")).rejects.toBeInstanceOf(ApiError);
    expect(assign).toHaveBeenCalledWith("/app/login");
    expect(getCurrentIdentity()).toBeNull();
  });
});

describe("api() on 401 — sign-in steps", () => {
  it.each([
    "/api/v2/auth/login",
    "/api/v2/auth/login/totp",
    "/api/v2/auth/login/recovery",
    "/api/v2/auth/login/totp/enroll/confirm",
    "/api/v2/auth/login-cross-store",
  ])("%s: shows the error, no refresh, no bounce", async (path) => {
    fetchMock.mockResolvedValueOnce(json(401, { detail: "Invalid code." }));
    const err = (await api(path, { method: "POST", json: {} })
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("Invalid code.");
    expect(calls()).toEqual([path]);
    expect(assign).not.toHaveBeenCalled();
    // The signed-in hint (and with it any pending flow) is untouched.
    expect(getCurrentIdentity()).not.toBeNull();
  });

  it("does not exempt look-alike paths", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { detail: "expired" }))
      .mockResolvedValueOnce(json(401, { detail: "dead" }));
    await api("/api/v2/auth/logins-report").catch(() => undefined);
    expect(calls()).toContain("/api/v2/auth/refresh");
    expect(assign).toHaveBeenCalledWith("/app/login");
  });
});

describe("api() on 401 — time-clock punches", () => {
  it.each([
    "/api/v2/timeclock/clock-in",
    "/api/v2/timeclock/clock-out",
    "/api/v2/timeclock/break/start",
    "/api/v2/timeclock/break/stop",
    "/api/v2/timeclock/passkey/challenge",
  ])("%s: a refused punch on a live session shows the error", async (path) => {
    fetchMock
      .mockResolvedValueOnce(json(401, { detail: "Passkey check failed." }))
      .mockResolvedValueOnce(json(200, REFRESHED))
      .mockResolvedValueOnce(json(401, { detail: "Passkey check failed." }));
    const err = (await api(path, { method: "POST", json: {} })
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("Passkey check failed.");
    expect(assign).not.toHaveBeenCalled();
    expect(getCurrentIdentity()).not.toBeNull();
  });

  it("still signs out when the session itself is dead", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { detail: "expired" }))
      .mockResolvedValueOnce(json(401, { detail: "refresh revoked" }));
    await api("/api/v2/timeclock/clock-in", { method: "POST", json: {} })
      .catch(() => undefined);
    expect(assign).toHaveBeenCalledWith("/app/login");
  });
});
