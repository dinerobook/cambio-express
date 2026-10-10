import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Login from "./Login";
import { ApiError } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";

// Sign-in is the front door. Pinned here (CLAUDE.md invariant #13):
//   - a role that needs 2FA never gets an identity from the password
//     step alone — the page moves to the code step and only the
//     TOTP / recovery response finishes the login;
//   - enroll_required sends the person to /login/2fa/enroll;
//   - the 409 store_ambiguous answer shows a store picker and the
//     pick re-submits with that store_id;
//   - an owner lands inside a store, or on the owner overview when
//     no store could be entered;
//   - server refusals render verbatim.

const api = vi.fn();
const autoEnterOwnerStore = vi.fn();

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return { ...real, api: (...a: unknown[]) => api(...a) };
});
vi.mock("../api/switchStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/switchStore")>();
  return { ...real, autoEnterOwnerStore: () => autoEnterOwnerStore() };
});

const ok = {
  user_id: 9, username: "ana", full_name: "Ana", role: "admin",
  store_id: 3, permissions: ["transfers.read"], access_token: "jwt",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<p>dashboard page</p>} />
        <Route path="/owner/dashboard" element={<p>owner overview</p>} />
        <Route path="/login/2fa/enroll" element={<p>enroll page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function signIn(user = " ana ", pw = "secret") {
  await userEvent.type(screen.getByLabelText("Email or phone"), user);
  await userEvent.type(screen.getByPlaceholderText("••••••••"), pw);
  await userEvent.click(screen.getByRole("button", { name: "Sign in →" }));
}

describe("Login", () => {
  beforeEach(() => {
    window.localStorage.clear();
    api.mockReset();
    autoEnterOwnerStore.mockReset();
  });

  it("disables Sign in until both fields are filled", async () => {
    renderPage();
    const btn = screen.getByRole("button", { name: "Sign in →" });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Email or phone"), "ana");
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText("••••••••"), "x");
    expect(btn).toBeEnabled();
  });

  it("posts trimmed creds, stores the identity and lands on the dashboard", async () => {
    api.mockResolvedValue(ok);
    renderPage();
    await signIn();
    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/v2/auth/login-cross-store", {
      method: "POST", json: { username: "ana", password: "secret" },
    });
    expect(getCurrentIdentity()).toMatchObject({ user_id: 9, role: "admin", store_id: 3 });
  });

  it("shows the server's refusal and stays on the form", async () => {
    api.mockRejectedValue(new ApiError(401, "Invalid username or password.", null));
    renderPage();
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password.");
    expect(getCurrentIdentity()).toBeNull();
  });

  it("asks for the TOTP code without persisting an identity, then finishes on verify", async () => {
    api.mockResolvedValueOnce({
      ...ok, role: "superadmin", requires_totp: true,
      pending_token: "pend", has_recovery_codes: true, access_token: null,
    });
    renderPage();
    await signIn();
    expect(await screen.findByText("Verify your identity")).toBeInTheDocument();
    expect(getCurrentIdentity()).toBeNull();

    api.mockResolvedValueOnce({ ...ok, role: "superadmin" });
    await userEvent.type(screen.getByLabelText("Verification code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify →" }));
    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
    expect(api).toHaveBeenLastCalledWith("/api/v2/auth/login/totp", {
      method: "POST", json: { pending_token: "pend", code: "123456" },
    });
    expect(getCurrentIdentity()?.role).toBe("superadmin");
  });

  it("switches to the recovery endpoint and shows a wrong-code refusal", async () => {
    api.mockResolvedValueOnce({
      ...ok, requires_totp: true, pending_token: "pend", has_recovery_codes: true,
    });
    renderPage();
    await signIn();
    await userEvent.click(await screen.findByRole("button", { name: "Use a recovery code" }));
    api.mockRejectedValueOnce(new ApiError(401, "Invalid code.", null));
    await userEvent.type(screen.getByLabelText("Recovery code"), "ABCD-1234");
    await userEvent.click(screen.getByRole("button", { name: "Verify →" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid code.");
    expect(api).toHaveBeenLastCalledWith("/api/v2/auth/login/recovery", expect.anything());
    expect(getCurrentIdentity()).toBeNull();
  });

  it("sends a not-yet-enrolled 2FA role to the enrollment page", async () => {
    api.mockResolvedValue({
      ...ok, requires_totp: true, pending_token: "pend", enroll_required: true,
    });
    renderPage();
    await signIn();
    expect(await screen.findByText("enroll page")).toBeInTheDocument();
    expect(getCurrentIdentity()).toBeNull();
  });

  it("asks which store when the creds work at several, then signs in to the pick", async () => {
    api.mockRejectedValueOnce(new ApiError(409, "ambiguous", {
      detail: {
        code: "store_ambiguous",
        stores: [
          { store_id: 3, store_name: "North", role: "admin" },
          { store_id: 4, store_name: "", role: "employee" },
        ],
      },
    }));
    renderPage();
    await signIn();
    expect(await screen.findByText("Which store?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Store #4/ })).toBeInTheDocument();

    api.mockResolvedValueOnce(ok);
    await userEvent.click(screen.getByRole("button", { name: /North/ }));
    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
    expect(api).toHaveBeenLastCalledWith("/api/v2/auth/login", {
      method: "POST", json: { username: "ana", password: "secret", store_id: 3 },
    });
  });

  it("lands an owner on the owner overview when no store can be entered", async () => {
    api.mockResolvedValue({ ...ok, role: "owner", store_id: null });
    autoEnterOwnerStore.mockResolvedValue(false);
    renderPage();
    await signIn();
    expect(await screen.findByText("owner overview")).toBeInTheDocument();
    await waitFor(() => expect(autoEnterOwnerStore).toHaveBeenCalledTimes(1));
  });

  it("lands an owner inside a store when one is entered", async () => {
    api.mockResolvedValue({ ...ok, role: "owner", store_id: null });
    autoEnterOwnerStore.mockResolvedValue(true);
    renderPage();
    await signIn();
    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
  });
});
