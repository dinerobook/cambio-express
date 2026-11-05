import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AccountSessions from "./AccountSessions";
import type { ActiveSessionRow } from "../api/account";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";

// Devices page (Account → Devices): every browser the person is signed
// in on, on the kit <DataTable>. The current one is marked and has no
// Sign out; any other signs out on click, and a refusal says so.
// "Sign out everywhere else" asks first.

let state: {
  data?: { sessions: ActiveSessionRow[] };
  isLoading: boolean; isError: boolean; error?: unknown;
};
const refetch = vi.fn();
const revokeSession = vi.fn();
const revokeOtherSessions = vi.fn();

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    useActiveSessions: () => ({ ...state, refetch }),
    revokeSession: (...a: unknown[]) => revokeSession(...a),
    revokeOtherSessions: () => revokeOtherSessions(),
  };
});

function session(id: string, over: Partial<ActiveSessionRow> = {}): ActiveSessionRow {
  return {
    session_id: id,
    user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537.36",
    ip_address: "203.0.113.7",
    is_current: false,
    started_at: "2026-11-01T12:00:00",
    last_used_at: "2026-11-05T12:00:00",
    expires_at: "2026-12-01T12:00:00",
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/account/sessions"]}>
          <AccountSessions />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("AccountSessions", () => {
  beforeEach(() => {
    refetch.mockReset();
    revokeSession.mockReset();
    revokeOtherSessions.mockReset();
    state = {
      data: {
        sessions: [
          session("here", { is_current: true }),
          session("phone", {
            user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1",
            ip_address: "198.51.100.4",
          }),
        ],
      },
      isLoading: false, isError: false,
    };
  });

  it("lists each device on the shared table, the current one marked", () => {
    renderPage();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(["Device", "Last activity", "Signed in", "IP", ""]);
    const here = screen.getByText("This device").closest("tr")!;
    expect(within(here).getByText("Chrome on macOS")).toBeInTheDocument();
    expect(within(here).getByText("Current")).toBeInTheDocument();
    expect(within(here).queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    const phone = screen.getByText("Safari on iPhone").closest("tr")!;
    expect(within(phone).getByText("198.51.100.4")).toBeInTheDocument();
  });

  it("signs out another device", async () => {
    revokeSession.mockResolvedValue({ revoked: 1 });
    renderPage();
    const phone = screen.getByText("Safari on iPhone").closest("tr")!;
    await userEvent.click(within(phone).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith("phone"));
    expect(await screen.findByText("Session signed out.")).toBeInTheDocument();
  });

  it("shows a refused sign out", async () => {
    revokeSession.mockRejectedValue(new ApiError(403, "Not your session", null));
    renderPage();
    const phone = screen.getByText("Safari on iPhone").closest("tr")!;
    await userEvent.click(within(phone).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Not your session")).toBeInTheDocument();
  });

  it("asks before signing out every other device", async () => {
    revokeOtherSessions.mockResolvedValue({ revoked: 1 });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Sign out everywhere else" }));
    expect(revokeOtherSessions).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out everywhere else" }));
    await waitFor(() => expect(revokeOtherSessions).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Signed out 1 other session.")).toBeInTheDocument();
  });

  it("shows the load error with a retry", async () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "Boom", null) };
    renderPage();
    expect(screen.getByText(/Couldn't load sessions/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });
});
