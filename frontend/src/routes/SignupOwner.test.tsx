import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SignupOwner from "./SignupOwner";
import { ApiError } from "../lib/api";

// Multi-store owner signup: creates the owner, then lands on the
// owner overview. Refusals render on the field the server names.

const signupOwner = vi.fn();
const setAccessToken = vi.fn();

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return { ...real, signupOwner: (...a: unknown[]) => signupOwner(...a) };
});
vi.mock("../lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/auth")>();
  return { ...real, setAccessToken: (t: string) => setAccessToken(t) };
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/signup/owner"]}>
      <Routes>
        <Route path="/signup/owner" element={<SignupOwner />} />
        <Route path="/owner/dashboard" element={<p>owner overview</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fill() {
  await userEvent.type(screen.getByLabelText("Full Name"), " Rosa Diaz ");
  await userEvent.type(screen.getByLabelText("Email"), "rosa@chain.com ");
  await userEvent.type(screen.getByLabelText("Password"), "longpass1");
  await userEvent.click(screen.getByRole("button", { name: "Create owner account →" }));
}

describe("SignupOwner", () => {
  beforeEach(() => {
    signupOwner.mockReset();
    setAccessToken.mockReset();
  });

  it("disables submit until every field is filled", async () => {
    renderPage();
    const btn = screen.getByRole("button", { name: "Create owner account →" });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Full Name"), "R");
    await userEvent.type(screen.getByLabelText("Email"), "r@x.co");
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Password"), "p");
    expect(btn).toBeEnabled();
  });

  it("creates the owner with trimmed fields and lands on the owner overview", async () => {
    signupOwner.mockResolvedValue({ access_token: "jwt-owner" });
    renderPage();
    await fill();
    expect(await screen.findByText("owner overview")).toBeInTheDocument();
    expect(signupOwner).toHaveBeenCalledWith({
      full_name: "Rosa Diaz", email: "rosa@chain.com", password: "longpass1",
    });
    expect(setAccessToken).toHaveBeenCalledWith("jwt-owner");
  });

  it("shows a field refusal under the field", async () => {
    signupOwner.mockRejectedValue(new ApiError(400, "Bad", {
      detail: { field: "password", message: "Password is too common." },
    }));
    renderPage();
    await fill();
    expect(await screen.findByText("Password is too common.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(setAccessToken).not.toHaveBeenCalled();
  });

  it("shows a general refusal as an alert", async () => {
    signupOwner.mockRejectedValue(new ApiError(429, "Too many attempts.", null));
    renderPage();
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts.");
  });
});
