import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Signup from "./Signup";
import { ApiError } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";

// Owner-first signup (U-4b). Pinned: the body the API receives
// (trimmed, upper-cased referral code, chosen business type), the
// identity is cached and the new store auto-entered, a field-level
// refusal lands on its field (not a banner), and a ?ref= code
// previews the referral reward.

const signup = vi.fn();
const previewReferral = vi.fn();
const autoEnterOwnerStore = vi.fn();

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    signup: (...a: unknown[]) => signup(...a),
    previewReferral: (...a: unknown[]) => previewReferral(...a),
  };
});
vi.mock("../api/switchStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/switchStore")>();
  return { ...real, autoEnterOwnerStore: () => autoEnterOwnerStore() };
});

function renderPage(url = "/signup") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/signup" element={<Signup />} />
        <Route path="/home" element={<p>home page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillRequired() {
  await userEvent.type(screen.getByLabelText(/^Store Name/), "  Lamar Corner  ");
  await userEvent.type(screen.getByLabelText(/^Store Email/), "lamar@shop.com");
  await userEvent.type(screen.getByLabelText(/^Password/), "longpass1");
}

describe("Signup", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signup.mockReset();
    previewReferral.mockReset();
    previewReferral.mockRejectedValue(new ApiError(404, "not found", null));
    autoEnterOwnerStore.mockReset();
    autoEnterOwnerStore.mockResolvedValue(true);
  });

  it("creates the store, caches the identity and enters it", async () => {
    signup.mockResolvedValue({
      user_id: 5, username: "lamar@shop.com", full_name: "", role: "owner",
      store_id: 12, permissions: [], access_token: "jwt",
    });
    renderPage();
    await fillRequired();
    await userEvent.selectOptions(screen.getByLabelText("Business type"), "gas_station");
    await userEvent.click(screen.getByRole("button", { name: "Start free trial →" }));
    expect(await screen.findByText("home page")).toBeInTheDocument();
    expect(signup).toHaveBeenCalledWith({
      store_name: "Lamar Corner", email: "lamar@shop.com", password: "longpass1",
      phone: "", ref_code: "", business_type: "gas_station",
    });
    expect(getCurrentIdentity()).toMatchObject({ user_id: 5, role: "owner", store_id: 12 });
    expect(autoEnterOwnerStore).toHaveBeenCalledTimes(1);
  });

  it("puts a field-level refusal under its field, not in a banner", async () => {
    signup.mockRejectedValue(new ApiError(400, "Email already registered.", {
      detail: { field: "email", message: "That email is already in use." },
    }));
    renderPage();
    await fillRequired();
    await userEvent.click(screen.getByRole("button", { name: "Start free trial →" }));
    expect(await screen.findByText("That email is already in use.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getCurrentIdentity()).toBeNull();
  });

  it("shows a general refusal as an alert", async () => {
    signup.mockRejectedValue(new ApiError(503, "Signups are paused.", null));
    renderPage();
    await fillRequired();
    await userEvent.click(screen.getByRole("button", { name: "Start free trial →" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Signups are paused.");
  });

  it("previews a ?ref= code and sends it upper-cased", async () => {
    previewReferral.mockResolvedValue({ code: "ABCD1234", reward_referee_cents: 5000 });
    signup.mockResolvedValue({
      user_id: 5, username: "x", full_name: "", role: "owner",
      store_id: 1, permissions: [], access_token: "jwt",
    });
    renderPage("/signup?ref=abcd1234");
    expect(await screen.findByText(/Referred by a DineroBook user/)).toHaveTextContent("$50");
    expect(previewReferral).toHaveBeenCalledWith("ABCD1234");
    await fillRequired();
    await userEvent.click(screen.getByRole("button", { name: "Start free trial →" }));
    await waitFor(() => expect(signup).toHaveBeenCalledWith(
      expect.objectContaining({ ref_code: "ABCD1234" }),
    ));
  });
});
