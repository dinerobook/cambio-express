import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import SectionHub from "./SectionHub";
import { mockFetch } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// The sidebar's "pick where to go" hubs. The store's work is split
// into MSB and Retail (owner, 2026-11-19); the old section links
// must not strand anyone.

describe("SectionHub", () => {
  beforeEach(() => {
    signInAs();
    mockFetch({ "GET /api/v2/auth/session-status": { body: {} } });
  });

  it("shows the MSB section's pages", async () => {
    renderRoute(<SectionHub />, { path: "/hub/:key", at: "/hub/msb" });
    expect(await screen.findByRole("heading", { name: "MSB" })).toBeInTheDocument();
    expect(screen.getByText("MSB daily book")).toBeInTheDocument();
    expect(screen.getByText("Transfers")).toBeInTheDocument();
  });

  it("opens MSB from the old Money services link", async () => {
    renderRoute(<SectionHub />, { path: "/hub/:key", at: "/hub/money-services" });
    expect(await screen.findByRole("heading", { name: "MSB" })).toBeInTheDocument();
  });

  it("sends the old Daily link, now split in two, to the dashboard", async () => {
    renderRoute(<SectionHub />, { path: "/hub/:key", at: "/hub/daily" });
    expect(await screen.findByText("Navigated to /dashboard")).toBeInTheDocument();
  });
});
