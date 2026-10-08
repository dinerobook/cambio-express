import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startImpersonation, stopImpersonation } from "./impersonation";

// A real JWT shape (header.payload.signature) so the identity cache
// decodes it; the signature is never checked client-side.
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

describe("impersonation", () => {
  const assign = vi.fn();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign, pathname: "/app/superadmin/users" },
    });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockReset();
  });

  it("start caches the customer's claims and reloads into their app", async () => {
    const token = fakeJwt({
      sub: "42", role: "admin", store_id: 7, username: "maria@shop.com",
      name: "Maria Lopez", perms: ["transfers.view"], impersonated_by: 1,
    });
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ token, user: { id: 42, username: "maria@shop.com", role: "admin", store_id: 7, full_name: "Maria Lopez" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    await startImpersonation(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/v2/superadmin/impersonate/42");
    const cached = JSON.parse(window.localStorage.getItem("db.identity") ?? "null");
    expect(cached).toMatchObject({ user_id: 42, role: "admin", store_id: 7 });
    expect(cached.permissions).toEqual(["transfers.view"]);
    expect(assign).toHaveBeenCalledWith("/app/dashboard");
  });

  it("stop ends it server-side, restores the superadmin and returns to Users", async () => {
    window.localStorage.setItem("db.identity", JSON.stringify({
      user_id: 42, username: "maria@shop.com", full_name: "Maria", role: "admin",
      store_id: 7, permissions: [],
    }));
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user_id: 1, username: "superadmin", full_name: "Platform Admin",
        role: "superadmin", store_id: null, permissions: [],
      }), { status: 200 }));
    await stopImpersonation();
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/v2/superadmin/impersonate/stop");
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/v2/auth/refresh");
    const cached = JSON.parse(window.localStorage.getItem("db.identity") ?? "null");
    expect(cached).toMatchObject({ user_id: 1, role: "superadmin" });
    expect(assign).toHaveBeenCalledWith("/app/superadmin/users");
  });

  it("stop falls back to the login page when the superadmin session is gone", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    await stopImpersonation();
    expect(window.localStorage.getItem("db.identity")).toBeNull();
    expect(assign).toHaveBeenCalledWith("/app/login");
  });

  it("stop still restores the superadmin when the customer token already expired", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user_id: 1, username: "superadmin", full_name: "", role: "superadmin",
        store_id: null, permissions: [],
      }), { status: 200 }));
    await stopImpersonation();
    expect(assign).toHaveBeenCalledWith("/app/superadmin/users");
  });
});
