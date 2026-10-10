import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { TabsBar, TabsButton, TabsLink } from "./Tabs";

// Gating of TabsLink by permission is pinned in gating.test.tsx;
// here: the active-state contract of both flavors.

describe("<TabsLink>", () => {
  it("marks the tab matching the current URL as active", () => {
    render(
      <MemoryRouter initialEntries={["/settings/general"]}>
        <TabsBar>
          <TabsLink to="/settings/profile">Profile</TabsLink>
          <TabsLink to="/settings/general">General</TabsLink>
        </TabsBar>
      </MemoryRouter>,
    );
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("tab", { name: "Profile" })).not.toHaveAttribute("aria-current");
  });

  it("`end` stops a prefix tab from matching its sub-routes", () => {
    render(
      <MemoryRouter initialEntries={["/settings/general"]}>
        <TabsBar>
          <TabsLink to="/settings" end>Overview</TabsLink>
          <TabsLink to="/settings/general">General</TabsLink>
        </TabsBar>
      </MemoryRouter>,
    );
    expect(screen.getByRole("tab", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });
});

describe("<TabsButton>", () => {
  it("reflects `active` in aria-selected and fires onClick", async () => {
    const onClick = vi.fn();
    render(
      <TabsBar>
        <TabsButton active onClick={() => {}}>A</TabsButton>
        <TabsButton active={false} onClick={onClick}>B</TabsButton>
      </TabsBar>,
    );
    expect(screen.getByRole("tab", { name: "A" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "B" })).toHaveAttribute("aria-selected", "false");
    await userEvent.click(screen.getByRole("tab", { name: "B" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
