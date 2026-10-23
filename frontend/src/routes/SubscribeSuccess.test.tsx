import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SubscribeSuccess from "./SubscribeSuccess";

// Stripe's success_url. The webhook that moves the store onto its paid
// plan can land after the redirect, so the page polls store info until
// it does (or ~30 s pass) and flips from "Payment received" to
// "You're on <plan>" by itself.

const refetch = vi.fn();
let storeInfo: { store: { plan: string } } | undefined;
let identity: object | null;

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return { ...real, useStoreInfo: () => ({ data: storeInfo, refetch }) };
});

vi.mock("../lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/auth")>();
  return { ...real, getCurrentIdentity: () => identity };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <SubscribeSuccess />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  refetch.mockReset();
  storeInfo = { store: { plan: "trial" } };
  identity = { user_id: 1, role: "admin" };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SubscribeSuccess", () => {
  it("says the payment is in while the plan is still trial", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to dashboard/ })).toHaveAttribute("href", "/dashboard");
  });

  it("shows the paid plan once it is active", () => {
    storeInfo = { store: { plan: "pro" } };
    renderPage();
    expect(screen.getByRole("heading", { name: "You're on Pro" })).toBeInTheDocument();
  });

  it("polls every 2 s and stops after about 30 s", () => {
    renderPage();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(refetch).toHaveBeenCalledTimes(1);
    // Each tick re-arms after the render it causes, so step through.
    for (let i = 0; i < 30; i++) act(() => { vi.advanceTimersByTime(2000); });
    expect(refetch).toHaveBeenCalledTimes(15);
  });

  it("stops polling once the plan is active", () => {
    storeInfo = { store: { plan: "basic" } };
    renderPage();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(refetch).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "You're on Basic" })).toBeInTheDocument();
  });

  it("asks a signed-out visitor to sign in", () => {
    identity = null;
    renderPage();
    expect(screen.getByText("Sign in to view your subscription status.")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
