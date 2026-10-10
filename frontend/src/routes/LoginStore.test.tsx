import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LoginStore from "./LoginStore";
import { ApiError } from "../lib/api";

// /login/:slug — the per-store employee sign-in kept for old
// bookmarks. Pinned: an unknown slug never shows the form, and the
// login is scoped to the resolved store_id.

const api = vi.fn();
const lookupStoreBySlug = vi.fn();
const setAccessToken = vi.fn();

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return { ...real, api: (...a: unknown[]) => api(...a) };
});
vi.mock("../lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/auth")>();
  return { ...real, setAccessToken: (t: string) => setAccessToken(t) };
});
vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return { ...real, lookupStoreBySlug: (s: string) => lookupStoreBySlug(s) };
});

function renderPage(slug = "lamar") {
  return render(
    <MemoryRouter initialEntries={[`/login/${slug}`]}>
      <Routes>
        <Route path="/login/:slug" element={<LoginStore />} />
        <Route path="/dashboard" element={<p>dashboard page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function signIn() {
  await userEvent.type(await screen.findByLabelText("Username"), " maria ");
  await userEvent.type(screen.getByLabelText("Password"), "pw");
  await userEvent.click(screen.getByRole("button", { name: "Sign in →" }));
}

describe("LoginStore", () => {
  beforeEach(() => {
    api.mockReset();
    setAccessToken.mockReset();
    lookupStoreBySlug.mockReset();
    lookupStoreBySlug.mockResolvedValue({ store_id: 7, name: "Lamar Corner", slug: "lamar" });
  });

  it("shows 'Store not found' for an unknown slug", async () => {
    lookupStoreBySlug.mockResolvedValue(null);
    renderPage("nope");
    expect(await screen.findByText("Store not found")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(lookupStoreBySlug).toHaveBeenCalledWith("nope");
  });

  it("treats a failed lookup as not found", async () => {
    lookupStoreBySlug.mockRejectedValue(new ApiError(500, "boom", null));
    renderPage();
    expect(await screen.findByText("Store not found")).toBeInTheDocument();
  });

  it("signs in scoped to the resolved store", async () => {
    api.mockResolvedValue({ access_token: "jwt-e" });
    renderPage();
    expect(await screen.findByText(/LAMAR CORNER/)).toBeInTheDocument();
    await signIn();
    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/v2/auth/login", {
      method: "POST", json: { username: "maria", password: "pw", store_id: 7 },
    });
    expect(setAccessToken).toHaveBeenCalledWith("jwt-e");
  });

  it("shows the server's refusal", async () => {
    api.mockRejectedValue(new ApiError(401, "Invalid username or password.", null));
    renderPage();
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password.");
    expect(setAccessToken).not.toHaveBeenCalled();
  });
});
