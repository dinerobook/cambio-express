import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import Gate from "./Gate";
import RequireAuth from "./RequireAuth";
import { getCurrentIdentity } from "../lib/auth";
import { mockFetch } from "../test/fetchMock";
import { signInAs } from "../test/renderRoute";

// The two route guards. <Gate> reads lib/access.ts for every authed
// route; <RequireAuth> recovers a session from the refresh cookie
// when the identity cache was wiped (iOS PWAs) and otherwise sends
// the person to /login remembering where they were going.

function Where() {
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from;
  return <p>At {loc.pathname}{from ? ` from ${from}` : ""}</p>;
}

function renderGuard(guard: "gate" | "auth", at: string) {
  const Guard = guard === "gate" ? Gate : RequireAuth;
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/login" element={<Where />} />
        <Route path="/dashboard" element={<Where />} />
        <Route path="*" element={<Guard><p>Protected page</p></Guard>} />
      </Routes>
    </MemoryRouter>,
  );
}

function signOut() {
  window.localStorage.removeItem("db.identity");
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("Gate", () => {
  it("lets a person with the route's permission through", () => {
    renderGuard("gate", "/transfers");
    expect(screen.getByText("Protected page")).toBeInTheDocument();
  });

  it("bounces a person without the permission to the dashboard", () => {
    signInAs({ without: ["transfers.read"] });
    renderGuard("gate", "/transfers");
    expect(screen.getByText("At /dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Protected page")).not.toBeInTheDocument();
  });

  it("applies the role list: an employee holding time_clock.read still can't open payroll", () => {
    signInAs({ role: "employee" });
    renderGuard("gate", "/admin/timeclock");
    expect(screen.getByText("At /dashboard")).toBeInTheDocument();
  });

  it("lets the superadmin past a permission rule but not a store-only role rule", () => {
    signInAs({ role: "superadmin", store_id: null, permissions: [] });
    const { unmount } = renderGuard("gate", "/transfers");
    expect(screen.getByText("Protected page")).toBeInTheDocument();
    unmount();
    renderGuard("gate", "/settings/billing");
    expect(screen.getByText("At /dashboard")).toBeInTheDocument();
  });

  it("refuses a route missing from the access table (fail closed)", () => {
    renderGuard("gate", "/not-a-real-page");
    expect(screen.getByText("At /dashboard")).toBeInTheDocument();
  });

  it("sends a signed-out visitor to login", () => {
    signOut();
    renderGuard("gate", "/transfers");
    expect(screen.getByText("At /login")).toBeInTheDocument();
  });
});

describe("RequireAuth", () => {
  it("renders the page at once when the identity is cached", () => {
    const calls = mockFetch({});
    renderGuard("auth", "/transfers");
    expect(screen.getByText("Protected page")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("recovers the session from the refresh cookie", async () => {
    signOut();
    const calls = mockFetch({
      "POST /api/v2/auth/refresh": {
        body: {
          user_id: 7, username: "ana", full_name: "Ana", role: "employee",
          store_id: 1, permissions: ["transfers.read"],
        },
      },
    });
    renderGuard("auth", "/transfers");
    expect(await screen.findByText("Protected page")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(getCurrentIdentity()?.user_id).toBe(7);
  });

  it("sends the visitor to login, remembering the page, when refresh fails", async () => {
    signOut();
    mockFetch({ "POST /api/v2/auth/refresh": { status: 401, body: { detail: "expired" } } });
    renderGuard("auth", "/transfers?status=sent");
    expect(await screen.findByText("At /login from /transfers?status=sent")).toBeInTheDocument();
    expect(screen.queryByText("Protected page")).not.toBeInTheDocument();
  });

  it("treats a refresh reply without an identity as signed out", async () => {
    signOut();
    mockFetch({ "POST /api/v2/auth/refresh": { body: { ok: true } } });
    renderGuard("auth", "/daily");
    expect(await screen.findByText("At /login from /daily")).toBeInTheDocument();
  });
});
