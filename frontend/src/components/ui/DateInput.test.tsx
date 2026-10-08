import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DateInput } from "./DateInput";
import { Modal } from "./Modal";

// The shared date field:
//   - focusing or clicking it opens a calendar; picking a day writes
//     YYYY-MM-DD and closes it; typing still works;
//   - Escape or a click elsewhere closes it, a disabled field never
//     opens;
//   - inside a Modal the calendar renders outside the modal's
//     scrolling body (so it can't be clipped) and picking a day
//     leaves the modal open — the owner got stuck on exactly this.

function Controlled({ initial = "", onValue = vi.fn() }) {
  const [v, setV] = useState(initial);
  return (
    <DateInput
      value={v}
      onChange={(e) => { setV(e.target.value); onValue(e.target.value); }}
      aria-label="Due date"
    />
  );
}

describe("DateInput", () => {
  it("opens on focus and writes the picked day", async () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-10-07" onValue={onValue} />);
    await userEvent.click(screen.getByLabelText("Due date"));
    expect(screen.getByText("October 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /October 15/ }));
    expect(onValue).toHaveBeenLastCalledWith("2026-10-15");
    expect(screen.getByLabelText("Due date")).toHaveValue("2026-10-15");
    await waitFor(() =>
      expect(screen.queryByText("October 2026")).not.toBeInTheDocument());
  });

  it("still takes typed input", async () => {
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} />);
    await userEvent.type(screen.getByLabelText("Due date"), "2026-12-01");
    expect(screen.getByLabelText("Due date")).toHaveValue("2026-12-01");
    expect(onValue).toHaveBeenLastCalledWith("2026-12-01");
  });

  it("closes on Escape", async () => {
    render(<Controlled initial="2026-10-07" />);
    await userEvent.click(screen.getByLabelText("Due date"));
    expect(screen.getByText("October 2026")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText("October 2026")).not.toBeInTheDocument());
  });

  it("never opens when disabled", async () => {
    render(
      <DateInput value="2026-10-07" onChange={vi.fn()} disabled aria-label="Due date" />,
    );
    await userEvent.click(screen.getByLabelText("Due date"));
    expect(screen.queryByText("October 2026")).not.toBeInTheDocument();
  });

  it("works inside a Modal without being clipped or closing it", async () => {
    const onValue = vi.fn();
    const onClose = vi.fn();
    render(
      <Modal open title="Other cash out" onClose={onClose}>
        <Controlled initial="2026-10-07" onValue={onValue} />
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Other cash out" });
    await userEvent.click(screen.getByLabelText("Due date"));
    const caption = screen.getByText("October 2026");
    // Rendered outside the dialog's scrolling body.
    expect(dialog.contains(caption)).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /October 20/ }));
    expect(onValue).toHaveBeenLastCalledWith("2026-10-20");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Other cash out" })).toBeInTheDocument();
  });
});
