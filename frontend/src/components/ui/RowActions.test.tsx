import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RowActions } from "./RowActions";

// RowActions renders the desktop button row AND the mobile trigger
// (CSS picks one). jsdom applies no media queries, so both exist;
// the mobile trigger is display:none at desktop width (CSS module
// is applied), so it is queried with `hidden: true`. Permission gating
// is pinned in gating.test.tsx.

describe("<RowActions>", () => {
  it("renders one desktop button per visible action and skips hidden ones", () => {
    render(
      <RowActions actions={[
        { label: "Edit", onClick: () => {} },
        { label: "Approve", onClick: () => {}, hidden: true },
        { label: "Delete", onClick: () => {}, tone: "danger" },
      ]} />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("renders nothing when every action is hidden", () => {
    const { container } = render(
      <RowActions actions={[{ label: "Edit", onClick: () => {}, hidden: true }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("disables a busy or disabled action", () => {
    render(
      <RowActions actions={[
        { label: "Save", onClick: () => {}, busy: true },
        { label: "Void", onClick: () => {}, disabled: true },
      ]} />,
    );
    expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Void" })).toBeDisabled();
  });

  it("fires the desktop action's onClick", async () => {
    const onEdit = vi.fn();
    render(<RowActions actions={[{ label: "Edit", onClick: onEdit }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("opens the bottom sheet from the mobile trigger and closes it on pick", async () => {
    const onDelete = vi.fn();
    render(
      <RowActions
        label="More" title="Entry on May 15"
        actions={[
          { label: "Edit", onClick: () => {} },
          { label: "Delete", onClick: onDelete, tone: "danger" },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /More/, hidden: true }));
    const sheet = await screen.findByRole("dialog", { name: "Entry on May 15" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("gives the sheet an accessible name from the label when untitled", async () => {
    render(<RowActions actions={[{ label: "Edit", onClick: () => {} }]} />);
    await userEvent.click(screen.getByRole("button", { name: /Actions/, hidden: true }));
    expect(await screen.findByRole("dialog", { name: "Actions" })).toBeInTheDocument();
  });
});
