import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ForgotPassword from "./ForgotPassword";
import { ApiError } from "../lib/api";

// CLAUDE.md invariant #10: /forgot-password always answers "Check
// your email" — whether or not the address exists, and even when
// the request itself fails — so the page cannot be used to
// enumerate accounts.

const forgotPassword = vi.fn();

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    forgotPassword: (...a: unknown[]) => forgotPassword(...a),
  };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <ForgotPassword />
    </MemoryRouter>,
  );
}

describe("ForgotPassword", () => {
  beforeEach(() => {
    forgotPassword.mockReset();
    forgotPassword.mockResolvedValue({});
  });

  it("keeps Send disabled until an email is typed", async () => {
    renderPage();
    const send = screen.getByRole("button", { name: "Send reset link" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Email"), "a@b.co");
    expect(send).toBeEnabled();
  });

  it("sends the trimmed email and shows Check your email", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText("Email"), "  owner@shop.com  ");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(forgotPassword).toHaveBeenCalledWith("owner@shop.com"));
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
  });

  it("shows the same success screen when the server refuses (no enumeration)", async () => {
    forgotPassword.mockRejectedValue(new ApiError(404, "No such user", null));
    renderPage();
    await userEvent.type(screen.getByLabelText("Email"), "ghost@shop.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.queryByText("No such user")).not.toBeInTheDocument();
  });
});
