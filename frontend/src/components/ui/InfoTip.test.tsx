import { describe, it, expect } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Field } from "./Field";
import { InfoTip } from "./InfoTip";
import { Input } from "./Input";

describe("<InfoTip>", () => {
  it("renders a labelled icon button with no visible tip when idle", () => {
    render(<InfoTip text="Explains the thing." />);
    expect(screen.getByRole("button", { name: "More info" })).toBeTruthy();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("reveals the explanatory text on keyboard focus", async () => {
    const user = userEvent.setup();
    render(<InfoTip text="Auto-carried from yesterday." />);
    await act(async () => {
      await user.tab();
    });
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        "Auto-carried from yesterday.",
      );
    });
  });

  it("uses a custom accessible label when given", () => {
    render(<InfoTip text="x" label="About forward balance" />);
    expect(
      screen.getByRole("button", { name: "About forward balance" }),
    ).toBeTruthy();
  });

  it("never submits a surrounding form", () => {
    // Not a <button> at all, so it can never be a form's implicit
    // submit button.
    render(
      <form>
        <InfoTip text="x" />
      </form>,
    );
    const tip = screen.getByRole("button", { name: "More info" });
    expect(tip.tagName).not.toBe("BUTTON");
    expect(tip).toHaveAttribute("tabindex", "0");
  });

  it("leaves a Field's label on the input it describes", () => {
    // A <label> labels its first labelable descendant. When the tip
    // was a <button>, a Field like "State game # (i)" labelled the
    // icon, and the input had no accessible name.
    render(
      <Field label={<>State game # <InfoTip text="Printed on the pack." /></>}>
        <Input type="text" />
      </Field>,
    );
    expect(screen.getByLabelText(/State game #/)).toBe(screen.getByRole("textbox"));
  });
});
