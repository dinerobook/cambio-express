import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Privacy from "./Privacy";
import { renderRoute } from "../test/renderRoute";

// The privacy policy is a public page (Stripe links to it). It sits in
// the shared sign-in chrome so it follows the light/dark theme with
// every other public page, instead of its own inline stylesheet.

describe("Privacy", () => {
  it("renders the policy inside the shared public-page chrome", () => {
    const { container } = renderRoute(<Privacy />, { path: "/privacy" });
    expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" }))
      .toBeInTheDocument();
    expect(screen.getByText("PRIVACY POLICY")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "11. Contact us" }))
      .toBeInTheDocument();
    // Top bar: brand link home, and the back link.
    expect(screen.getByRole("link", { name: "DineroBook" }))
      .toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "← Back to home" }))
      .toHaveAttribute("href", "/");
    expect(container.querySelector("style")).toBeNull();
  });

  it("keeps the contact email as a mail link", () => {
    renderRoute(<Privacy />, { path: "/privacy" });
    expect(screen.getByRole("link", { name: "dinerobook26@gmail.com" }))
      .toHaveAttribute("href", "mailto:dinerobook26@gmail.com");
  });
});
