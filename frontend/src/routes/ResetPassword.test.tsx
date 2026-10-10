import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ResetPassword from "./ResetPassword";
import { ApiError } from "../lib/api";

// ResetPassword consumes the one-time token from the email link.
// Pinned: a link without a token never shows the form; the
// mismatch / length checks run before the API is called; the
// server's refusal (expired / used token) is shown verbatim.

const resetPassword = vi.fn();

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    resetPassword: (...a: unknown[]) => resetPassword(...a),
  };
});

function renderPage(url = "/reset-password?token=tok123") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/login" element={<p>login page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fill(pw: string, confirm: string) {
  await userEvent.type(screen.getByLabelText(/^New password/), pw);
  await userEvent.type(screen.getByLabelText(/^Confirm new password/), confirm);
  await userEvent.click(screen.getByRole("button", { name: "Update password" }));
}

describe("ResetPassword", () => {
  beforeEach(() => {
    resetPassword.mockReset();
    resetPassword.mockResolvedValue({});
  });

  it("shows 'Reset link missing' instead of the form without a token", () => {
    renderPage("/reset-password");
    expect(screen.getByText("Reset link missing")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument();
  });

  it("refuses mismatched passwords without calling the API", async () => {
    renderPage();
    await fill("longenough1", "longenough2");
    expect(await screen.findByRole("alert")).toHaveTextContent("Passwords do not match.");
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("sends the token + both passwords and then offers sign in", async () => {
    renderPage();
    await fill("newpass123", "newpass123");
    await waitFor(() => expect(resetPassword).toHaveBeenCalledWith({
      token: "tok123", new_password: "newpass123", confirm_password: "newpass123",
    }));
    expect(await screen.findByText("Password updated")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Sign in/ }));
    expect(await screen.findByText("login page")).toBeInTheDocument();
  });

  it("shows the server's reason when the token is refused", async () => {
    resetPassword.mockRejectedValue(new ApiError(400, "This link has expired.", null));
    renderPage();
    await fill("newpass123", "newpass123");
    expect(await screen.findByRole("alert")).toHaveTextContent("This link has expired.");
    expect(screen.queryByText("Password updated")).not.toBeInTheDocument();
  });
});
