import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SettingsProfile } from "./Settings";
import { ApiError } from "../lib/api";
import { renderRouteWithGuard } from "../test/renderRoute";

// Settings → Profile (your own name, email, phone, theme). Pinned:
// the form loads clean, an edit shows the Unsaved changes bar and
// holds a navigation away, Save sends the draft and clears the bar,
// and a refused save keeps both the edit and the bar.

const useProfile = vi.fn();
const updateProfile = vi.fn();

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    useProfile: () => useProfile(),
    updateProfile: (...a: unknown[]) => updateProfile(...a),
  };
});

const PROFILE = {
  user_id: 1, username: "ana@example.com", role: "admin",
  full_name: "Ana Ruiz", email: "", phone: "", timezone: "",
  theme_preference: "dark", created_at: "2026-01-02T00:00:00",
  last_login_at: "", timezone_choices: [],
};

beforeEach(() => {
  useProfile.mockReturnValue({
    data: PROFILE, isLoading: false, isError: false, error: null, refetch: vi.fn(),
  });
  updateProfile.mockReset().mockResolvedValue(PROFILE);
});

function renderTab() {
  return renderRouteWithGuard(<SettingsProfile />, { path: "/settings/profile" });
}

describe("Settings → Profile", () => {
  it("loads clean, with the login email in Email", () => {
    renderTab();
    expect(screen.getByLabelText(/^Display name/)).toHaveValue("Ana Ruiz");
    expect(screen.getByLabelText(/^Email/)).toHaveValue("ana@example.com");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
  });

  it("an edit shows Unsaved changes and holds a navigation away", async () => {
    const { router } = renderTab();
    await userEvent.type(screen.getByLabelText(/^Phone/), "555");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    act(() => { void router.navigate("/dashboard"); });
    expect(await screen.findByText(
      "You have unsaved edits to your profile. Leave without saving?",
    )).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/profile");
  });

  it("Save sends the draft and clears the bar", async () => {
    renderTab();
    await userEvent.type(screen.getByLabelText(/^Phone/), "555");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ full_name: "Ana Ruiz", phone: "555" }),
    ));
    expect(await screen.findByText("Profile updated.")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("a refused save shows the field's reason and keeps the edit", async () => {
    updateProfile.mockRejectedValue(new ApiError(422, "Invalid", {
      detail: { field_errors: { phone: "Not a phone number." } },
    }));
    renderTab();
    await userEvent.type(screen.getByLabelText(/^Phone/), "abc");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Not a phone number.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Phone/)).toHaveValue("abc");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
});
