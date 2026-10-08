import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { SlimSidebar, type NavGroup } from "./SlimSidebar";
import styles from "./SlimSidebar.module.css";

const groups: NavGroup[] = [
  { title: "Dashboard", icon: null, items: [], to: "/dashboard" },
  {
    title: "Daily", icon: null,
    items: [{ to: "/daily", label: "MSB Daily book", icon: null }],
  },
  {
    title: "Money", icon: null,
    items: [{ to: "/transfers", label: "Transfers", icon: null }],
  },
];

function renderRail(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SlimSidebar
        groups={groups}
        drawerOpen={false}
        supportLink={{ to: "/support", label: "Support", icon: null }}
      />
    </MemoryRouter>,
  );
}

// The slim column's controls only (the mobile drawer repeats the
// same labels as rows, so query by the rail's own accessible names).
const dashboard = () => screen.getByRole("link", { name: "Dashboard" });
const daily = () => screen.getByRole("button", { name: "Daily menu" });
const money = () => screen.getByRole("button", { name: "Money menu" });
const support = () => screen.getByRole("link", { name: "Support" });

function active() {
  return [dashboard(), daily(), money(), support()]
    .filter((el) => el.classList.contains(styles.isActive))
    .map((el) => el.getAttribute("aria-label"));
}

describe("<SlimSidebar> rail", () => {
  it("highlights only Dashboard on the dashboard route", () => {
    renderRail("/dashboard");
    expect(active()).toEqual(["Dashboard"]);
  });

  it("highlights the group that owns the current route", () => {
    renderRail("/transfers/new");
    expect(active()).toEqual(["Money menu"]);
  });

  it("opening a fly-out moves the highlight off Dashboard", async () => {
    renderRail("/dashboard");
    await userEvent.click(daily());
    expect(active()).toEqual(["Daily menu"]);
    expect(daily()).toHaveAttribute("aria-expanded", "true");
  });

  it("opening another group's fly-out moves the highlight off the route's group", async () => {
    renderRail("/transfers");
    await userEvent.click(daily());
    expect(active()).toEqual(["Daily menu"]);
  });

  it("opening a fly-out moves the highlight off Support", async () => {
    renderRail("/support");
    expect(active()).toEqual(["Support"]);
    await userEvent.click(money());
    expect(active()).toEqual(["Money menu"]);
  });

  it("closing the fly-out with ESC restores the route's highlight", async () => {
    renderRail("/dashboard");
    await userEvent.click(daily());
    await userEvent.keyboard("{Escape}");
    expect(active()).toEqual(["Dashboard"]);
  });

  it("clicking the open group again closes it and restores the highlight", async () => {
    renderRail("/dashboard");
    await userEvent.click(money());
    await userEvent.click(money());
    expect(money()).toHaveAttribute("aria-expanded", "false");
    expect(active()).toEqual(["Dashboard"]);
  });

  it("direct-link groups share the button groups' class (no link styling)", () => {
    renderRail("/daily");
    expect(dashboard().classList.contains(styles.groupBtn)).toBe(true);
    expect(daily().classList.contains(styles.groupBtn)).toBe(true);
  });
});
