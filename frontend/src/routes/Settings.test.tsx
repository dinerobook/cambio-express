import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Settings from "./Settings";

// The reported bug: an employee saw a Billing tab whose content
// hid itself. Tabs now come from the route table, so the set of
// tabs IS the set of pages the person can open.

vi.mock("../api/account", () => ({
  useProfile: () => ({ data: undefined, isLoading: true }),
  useStoreInfo: () => ({ data: undefined }),
  usePasskeys: () => ({ data: undefined, isLoading: true }),
  changePassword: vi.fn(), deletePasskey: vi.fn(), registerPasskey: vi.fn(),
  updateProfile: vi.fn(), updateStoreInfo: vi.fn(),
}));
vi.mock("../api/owner", () => ({ redeemConnectCode: vi.fn() }));

function signIn(role: string, permissions: string[]) {
  window.localStorage.setItem("db.identity", JSON.stringify({
    user_id: 1, username: "u", full_name: "U", role, store_id: 7, permissions,
  }));
}

function tabs(): string[] {
  return screen.getAllByRole("tab").map((el) => el.textContent ?? "");
}

describe("<Settings> tabs follow route access", () => {
  beforeEach(() => window.localStorage.clear());

  it("an employee without settings rights gets Profile + Security only", () => {
    signIn("employee", ["transfers.read"]);
    render(<MemoryRouter><Settings /></MemoryRouter>);
    expect(tabs()).toEqual(["Profile", "Security"]);
  });

  it("an employee granted settings.read gets General too, still no Billing", () => {
    signIn("employee", ["settings.read"]);
    render(<MemoryRouter><Settings /></MemoryRouter>);
    expect(tabs()).toEqual(["Profile", "General", "Security"]);
  });

  it("a store admin gets every tab", () => {
    signIn("admin", ["settings.read", "settings.update"]);
    render(<MemoryRouter><Settings /></MemoryRouter>);
    expect(tabs()).toEqual(["Profile", "General", "Billing", "Referrals", "Security"]);
  });

  it("an owner pays per store, so no Billing at the umbrella level", () => {
    signIn("owner", ["settings.read", "settings.update"]);
    render(<MemoryRouter><Settings /></MemoryRouter>);
    expect(tabs()).toEqual(["Profile", "General", "Security"]);
  });

  it("superadmin has no store: no General, no Billing", () => {
    signIn("superadmin", []);
    render(<MemoryRouter><Settings /></MemoryRouter>);
    expect(tabs()).toEqual(["Profile", "Security"]);
  });
});
