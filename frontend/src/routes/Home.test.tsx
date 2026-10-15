import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import Home from "./Home";
import { renderRoute, signInAs } from "../test/renderRoute";

// The site root opens on sign-in, not the marketing page: a
// signed-out visitor sees the form with the features panel beside
// it; a signed-in one goes straight to the dashboard.

describe("Home (site root)", () => {
  beforeEach(() => { window.localStorage.clear(); });

  it("shows the sign-in form and the features panel to a signed-out visitor", () => {
    renderRoute(<Home />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email or phone")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /does$/ })).toBeInTheDocument();
    expect(screen.queryByText(/Navigated to/)).not.toBeInTheDocument();
  });

  it("puts the sign-in form before the features panel in the page", () => {
    renderRoute(<Home />);
    const form = screen.getByLabelText("Email or phone");
    const panel = screen.getByRole("region", { name: /does$/ });
    expect(
      form.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("sends a signed-in visitor straight to the dashboard", () => {
    signInAs();
    renderRoute(<Home />);
    expect(screen.getByText("Navigated to /dashboard")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email or phone")).not.toBeInTheDocument();
  });
});
