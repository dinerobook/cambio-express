import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminUsers from "./SuperadminUsers";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import type { SuperadminUserRow } from "../api/superadmin";

// Platform user admin: every account-level lever a superadmin has
// (disable, reset password / 2FA, impersonate, revoke sessions,
// change role). Pinned: each lever goes through a confirm first,
// superadmin rows carry no actions, the temp password is shown
// once, impersonation starts in the right mode, and refusals are
// visible.

const fns = {
  toggleUserActive: vi.fn(),
  resetUser2FA: vi.fn(),
  forcePasswordReset: vi.fn(),
  revokeUserSessions: vi.fn(),
  changeUserRole: vi.fn(),
  createPlatformUser: vi.fn(),
};
const startImpersonation = vi.fn();
const useSuperadminUsers = vi.fn();
const refetch = vi.fn();
let state: {
  data?: { rows: SuperadminUserRow[]; total: number; page: number; total_pages: number };
  isLoading: boolean; isError: boolean; error?: unknown;
};

vi.mock("../api/superadmin", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/superadmin")>();
  return {
    ...real,
    useSuperadminStores: () => ({
      data: { rows: [{ store_id: 4, name: "North" }], total: 1 },
    }),
    useSuperadminUsers: (opts: unknown) => { useSuperadminUsers(opts); return { ...state, refetch }; },
    toggleUserActive: (...a: unknown[]) => fns.toggleUserActive(...a),
    resetUser2FA: (...a: unknown[]) => fns.resetUser2FA(...a),
    forcePasswordReset: (...a: unknown[]) => fns.forcePasswordReset(...a),
    revokeUserSessions: (...a: unknown[]) => fns.revokeUserSessions(...a),
    changeUserRole: (...a: unknown[]) => fns.changeUserRole(...a),
    createPlatformUser: (...a: unknown[]) => fns.createPlatformUser(...a),
  };
});
vi.mock("../lib/impersonation", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/impersonation")>();
  return { ...real, startImpersonation: (...a: unknown[]) => startImpersonation(...a) };
});

function user(id: number, username: string, over: Partial<SuperadminUserRow> = {}): SuperadminUserRow {
  return {
    id, username, full_name: username.toUpperCase(), email: `${username}@x.com`,
    role: "admin", store_id: 4, store_name: "North", is_active: true,
    has_2fa: false, last_login_at: "", created_at: "2026-01-01T00:00:00", ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <SuperadminUsers />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const rowOf = (name: string) => screen.getByText(name).closest("tr")!;

async function pick(rowName: string, action: string) {
  await userEvent.click(within(rowOf(rowName)).getByRole("button", { name: action }));
  return screen.findByRole("dialog");
}

describe("SuperadminUsers", () => {
  beforeEach(() => {
    Object.values(fns).forEach((f) => f.mockReset());
    startImpersonation.mockReset();
    useSuperadminUsers.mockReset();
    refetch.mockReset();
    state = {
      data: {
        rows: [
          user(1, "ana", { has_2fa: true }),
          user(2, "root", { role: "superadmin", store_id: null, store_name: "" }),
          user(3, "luis", { is_active: false, role: "employee" }),
        ],
        total: 3, page: 1, total_pages: 1,
      },
      isLoading: false, isError: false,
    };
  });

  it("lists users and gives superadmin rows no actions", () => {
    renderPage();
    expect(screen.getByText("3 users")).toBeInTheDocument();
    expect(within(rowOf("ANA")).getByText("Enrolled")).toBeInTheDocument();
    expect(within(rowOf("LUIS")).getByText("Inactive")).toBeInTheDocument();
    expect(within(rowOf("ROOT")).queryByRole("button")).not.toBeInTheDocument();
    // Reset 2FA only where 2FA is enrolled.
    expect(within(rowOf("LUIS")).queryByRole("button", { name: "Reset 2FA" })).not.toBeInTheDocument();
  });

  it("passes the filters to the query and resets to page 1", async () => {
    renderPage();
    await userEvent.selectOptions(screen.getByDisplayValue("All roles"), "owner");
    await userEvent.selectOptions(screen.getByDisplayValue("All stores"), "4");
    expect(useSuperadminUsers).toHaveBeenLastCalledWith({
      q: undefined, role: "owner", store_id: 4, page: 1,
    });
  });

  it("shows ErrorState with a working Retry", async () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "Users are down", null) };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Users are down");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("disables a user only after the confirm", async () => {
    fns.toggleUserActive.mockResolvedValue({ ok: true, is_active: false });
    renderPage();
    const dialog = await pick("ANA", "Disable");
    expect(fns.toggleUserActive).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(fns.toggleUserActive).toHaveBeenCalledWith(1));
    expect(await screen.findByText("User disabled.")).toBeInTheDocument();
  });

  it("cancel leaves the user untouched", async () => {
    renderPage();
    const dialog = await pick("ANA", "Revoke sessions");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fns.revokeUserSessions).not.toHaveBeenCalled();
  });

  it("shows the temporary password once after a reset", async () => {
    fns.forcePasswordReset.mockResolvedValue({ ok: true, temp_password: "Tmp-9x7Q" });
    renderPage();
    const dialog = await pick("LUIS", "Reset password");
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Tmp-9x7Q")).toBeInTheDocument();
    expect(fns.forcePasswordReset).toHaveBeenCalledWith(3);
  });

  it("starts read-only impersonation from 'View as'", async () => {
    startImpersonation.mockResolvedValue(undefined);
    renderPage();
    const dialog = await pick("ANA", "View as (read-only)");
    await userEvent.click(within(dialog).getByRole("button", { name: "View read-only" }));
    await waitFor(() => expect(startImpersonation).toHaveBeenCalledWith(1, "read_only"));
  });

  it("shows a refused action on the page once the dialog closes", async () => {
    fns.revokeUserSessions.mockRejectedValue(new ApiError(404, "User not found.", null));
    renderPage();
    const dialog = await pick("ANA", "Revoke sessions");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke sessions" }));
    expect(await screen.findByText("User not found.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("changes a role to the one picked", async () => {
    fns.changeUserRole.mockResolvedValue({ ok: true, role: "owner" });
    renderPage();
    const dialog = await pick("LUIS", "Change role");
    await userEvent.selectOptions(within(dialog).getByRole("combobox"), "owner");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change role" }));
    await waitFor(() => expect(fns.changeUserRole).toHaveBeenCalledWith(3, "owner"));
    expect(await screen.findByText("Role changed to owner.")).toBeInTheDocument();
  });

  // BUG: SuperadminUsers.tsx — a refused role change keeps the
  // "Change role" dialog open but writes the error to the page-level
  // <Alert>, which sits behind the modal (aria-hidden, covered).
  // ConfirmDialog has an `error` prop for exactly this case
  // (components/ui/Modal.tsx: "an error rendered there is one the
  // person never sees"); the page does not pass it.
  it.fails("shows a refused role change inside the still-open dialog", async () => {
    fns.changeUserRole.mockRejectedValue(new ApiError(403, "Cannot demote the last admin.", null));
    renderPage();
    const dialog = await pick("ANA", "Change role");
    await userEvent.selectOptions(within(dialog).getByRole("combobox"), "employee");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change role" }));
    await waitFor(() => expect(fns.changeUserRole).toHaveBeenCalled());
    expect(await within(screen.getByRole("dialog")).findByText("Cannot demote the last admin."))
      .toBeInTheDocument();
  });

  it("creates a support login and shows the refusal when it fails", async () => {
    fns.createPlatformUser.mockRejectedValueOnce(new ApiError(409, "Username taken.", null));
    fns.createPlatformUser.mockResolvedValueOnce({});
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Add support login" }));
    await userEvent.type(screen.getByLabelText("Username"), " helpdesk ");
    await userEvent.type(screen.getByLabelText(/^Password/), "longpass1");
    await userEvent.click(screen.getByRole("button", { name: "Create support login" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Username taken.");
    await userEvent.click(screen.getByRole("button", { name: "Create support login" }));
    await waitFor(() => expect(fns.createPlatformUser).toHaveBeenLastCalledWith({
      username: "helpdesk", full_name: "", email: "", password: "longpass1",
    }));
    expect(await screen.findByText('Support login "helpdesk" created.')).toBeInTheDocument();
  });
});
