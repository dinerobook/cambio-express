import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { PageCrumbs } from "./PageCrumbs";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

function trailAt(path: string, ui: React.ReactElement) {
  render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
  const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
  return within(nav).getAllByRole("listitem").map((li) => ({
    text: li.textContent?.replace(/^\//, "").trim(),
    href: li.querySelector("a")?.getAttribute("href") ?? null,
  }));
}

describe("PageCrumbs", () => {
  beforeEach(() => setCurrentIdentity(TEST_ADMIN));

  it("names a sidebar page by its section and sidebar label", () => {
    expect(trailAt("/transfers", <PageCrumbs />)).toEqual([
      { text: "Money services", href: "/hub/money-services" },
      { text: "Transfers", href: null },
    ]);
  });

  it("links the sidebar page above a page under it", () => {
    expect(trailAt("/transfers/12", <PageCrumbs current="Transfer #12" />)).toEqual([
      { text: "Money services", href: "/hub/money-services" },
      { text: "Transfers", href: "/transfers" },
      { text: "Transfer #12", href: null },
    ]);
  });

  it("picks the longest matching sidebar route", () => {
    // /bank/rules sits under both /bank and /bank/rules.
    expect(trailAt("/bank/rules", <PageCrumbs />).map((c) => c.text))
      .toEqual(["Finance", "Bank rules"]);
  });

  it("does not match a route that only shares a prefix of letters", () => {
    // /bank-transactions is its own item, not under /bank.
    expect(trailAt("/bank-transactions", <PageCrumbs />).map((c) => c.text))
      .toEqual(["Finance", "Bank transactions"]);
  });

  it("hangs a page the sidebar does not list under the page named", () => {
    expect(
      trailAt(
        "/monthly/categories",
        <PageCrumbs under="/reports" via={[{ label: "Monthly P&L", to: "/monthly" }]} current="Categories" />,
      ),
    ).toEqual([
      { text: "Reports", href: "/hub/reports" },
      { text: "MSB reports", href: "/reports" },
      { text: "Monthly P&L", href: "/monthly" },
      { text: "Categories", href: null },
    ]);
  });

  it("follows the person's own sidebar (owner)", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "owner" });
    expect(trailAt("/owner/connect", <PageCrumbs />).map((c) => c.text))
      .toEqual(["Owner", "Connect a store"]);
  });

  it("shows only the page when the sidebar has no entry for it", () => {
    expect(trailAt("/nowhere", <PageCrumbs current="Somewhere" />))
      .toEqual([{ text: "Somewhere", href: null }]);
  });
});
