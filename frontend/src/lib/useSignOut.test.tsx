import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentIdentity, getRefreshFallback } from "./auth";
import { useSignOut } from "./useSignOut";

// Sign out ends the session on the server too (POST /auth/logout
// revokes the refresh row), and leaves nothing of the last person on
// the device: identity hint, PWA refresh fallback, an owner's
// remembered store, the query cache. It lands on /login even when
// the server can't be reached.

const fetchMock = vi.fn();
let qc: QueryClient;

function setup() {
  let pathname = "";
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/dashboard"]}>
          {children}
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  const hook = renderHook(() => {
    pathname = useLocation().pathname;
    return useSignOut();
  }, { wrapper });
  return { hook, path: () => pathname };
}

beforeEach(() => {
  qc = new QueryClient();
  qc.setQueryData(["transfers", "list"], [{ id: 1, sender: "Ana" }]);
  window.localStorage.setItem("db.refresh_fallback", "jti-123");
  window.localStorage.setItem("db.owner_active_store", "4");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSignOut", () => {
  it("revokes on the server, clears the device and lands on /login", async () => {
    const { hook, path } = setup();
    expect(getCurrentIdentity()).not.toBeNull();
    await act(() => hook.result.current());

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v2/auth/logout",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(getCurrentIdentity()).toBeNull();
    expect(getRefreshFallback()).toBeNull();
    expect(window.localStorage.getItem("db.owner_active_store")).toBeNull();
    expect(qc.getQueryData(["transfers", "list"])).toBeUndefined();
    expect(path()).toBe("/login");
  });

  it("still signs out locally and lands on /login when the server is down", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { hook, path } = setup();
    await act(() => hook.result.current());
    expect(getCurrentIdentity()).toBeNull();
    expect(getRefreshFallback()).toBeNull();
    expect(qc.getQueryData(["transfers", "list"])).toBeUndefined();
    expect(path()).toBe("/login");
  });
});
