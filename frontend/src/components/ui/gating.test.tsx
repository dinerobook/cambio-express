import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppLink, Button, ButtonLink, RowActions, TabsBar, TabsLink } from "./index";

// No access, no control — at the kit level. A link, tab, button or
// row action that the signed-in person cannot use is not rendered,
// so a page cannot show a dead control by forgetting a check.

function signIn(role: string, permissions: string[]) {
  window.localStorage.setItem("db.identity", JSON.stringify({
    user_id: 1, username: "u", full_name: "U", role, store_id: 7, permissions,
  }));
}

describe("kit primitives hide what the person cannot open", () => {
  beforeEach(() => window.localStorage.clear());

  it("ButtonLink: hidden for a missing permission, shown when granted", () => {
    signIn("employee", ["transfers.read"]);
    render(
      <MemoryRouter>
        <ButtonLink to="/transfers/new">New transfer</ButtonLink>
        <ButtonLink to="/transfers">All transfers</ButtonLink>
      </MemoryRouter>,
    );
    expect(screen.queryByText("New transfer")).not.toBeInTheDocument();
    expect(screen.getByText("All transfers")).toBeInTheDocument();
  });

  it("ButtonLink: an in-app href is gated like `to`; API downloads are not", () => {
    signIn("employee", []);
    render(
      <MemoryRouter>
        <ButtonLink href="/batches/new">New batch</ButtonLink>
        <ButtonLink href="/api/v2/customers/export.csv">Export</ButtonLink>
      </MemoryRouter>,
    );
    expect(screen.queryByText("New batch")).not.toBeInTheDocument();
    expect(screen.getByText("Export")).toBeInTheDocument();
  });

  it("TabsLink: the tab disappears, not just its content", () => {
    signIn("employee", []);
    render(
      <MemoryRouter>
        <TabsBar>
          <TabsLink to="/settings/profile">Profile</TabsLink>
          <TabsLink to="/settings/billing">Billing</TabsLink>
        </TabsBar>
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Profile"]);
  });

  it("AppLink: hidden by default, plain text with fallback=\"text\"", () => {
    signIn("employee", []);
    render(
      <MemoryRouter>
        <AppLink to="/bank">Bank</AppLink>
        <p>Open the <AppLink to="/price-book" fallback="text">price book</AppLink> first.</p>
      </MemoryRouter>,
    );
    expect(screen.queryByText("Bank")).not.toBeInTheDocument();
    expect(screen.getByText(/price book/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("Button perm=: rendered only with the permission", () => {
    signIn("employee", ["lottery.read"]);
    render(
      <>
        <Button perm="lottery.update">Receive pack</Button>
        <Button perm="lottery.read">Count</Button>
        <Button>Plain</Button>
      </>,
    );
    expect(screen.queryByText("Receive pack")).not.toBeInTheDocument();
    expect(screen.getByText("Count")).toBeInTheDocument();
    expect(screen.getByText("Plain")).toBeInTheDocument();
  });

  it("RowActions perm: the action is dropped from the row; an empty row renders nothing", () => {
    signIn("employee", ["users.read"]);
    const { container } = render(
      <RowActions
        title="Amber"
        actions={[
          { label: "Edit", perm: "users.update", onClick: () => {} },
          { label: "Deactivate", perm: "users.update", onClick: () => {} },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("superadmin sees everything permission-gated", () => {
    signIn("superadmin", []);
    render(
      <MemoryRouter>
        <ButtonLink to="/batches/new">New batch</ButtonLink>
        <Button perm="users.update">Edit</Button>
      </MemoryRouter>,
    );
    expect(screen.getByText("New batch")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });
});
