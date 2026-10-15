import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Landing from "./Landing";
import { PRODUCT_FEATURES } from "../lib/productFeatures";
import { mockFetch } from "../test/fetchMock";
import { renderRoute } from "../test/renderRoute";

// The marketing page, now at /features (the site root opens on
// sign-in). It renders the whole shared product tour, prices from
// the server, and a way to sign in.

const plans = [
  { key: "basic", monthly_cents: 4900, yearly_cents: 49000, months_free: 2 },
  { key: "pro", monthly_cents: 9900, yearly_cents: 99000, months_free: 2 },
];

describe("Landing (/features)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("renders every product feature from the shared list", async () => {
    mockFetch({ "GET /api/v2/billing/pricing": { body: { plans } } });
    renderRoute(<Landing />, { path: "/features" });
    for (const f of PRODUCT_FEATURES) {
      expect(screen.getByText(f.title)).toBeInTheDocument();
      for (const p of f.points) expect(screen.getByText(p)).toBeInTheDocument();
    }
    // Prices come from the server, not a copy in the page.
    expect((await screen.findAllByText(/\$49\b/)).length).toBeGreaterThan(0);
  });

  it("keeps a Sign in link", () => {
    mockFetch({ "GET /api/v2/billing/pricing": { body: { plans } } });
    renderRoute(<Landing />, { path: "/features" });
    const signIns = screen.getAllByRole("link", { name: "Sign in" });
    expect(signIns.length).toBeGreaterThan(0);
    for (const a of signIns) expect(a).toHaveAttribute("href", "/login");
  });

  it("uses the shared brand link and in-app links in the top bar and footer", () => {
    mockFetch({ "GET /api/v2/billing/pricing": { body: { plans } } });
    renderRoute(<Landing />, { path: "/features" });
    const brands = screen.getAllByRole("link", { name: "DineroBook" });
    expect(brands).toHaveLength(2);
    for (const a of brands) expect(a).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Privacy" }))
      .toHaveAttribute("href", "/privacy");
  });
});
