import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Select } from "./Select";

describe("<Select>", () => {
  it("renders its options and forwards native props", () => {
    render(
      <label>
        Plan
        <Select name="plan" defaultValue="pro">
          <option value="basic">Basic</option>
          <option value="pro">Pro</option>
        </Select>
      </label>,
    );
    const sel = screen.getByLabelText("Plan");
    expect(sel).toHaveValue("pro");
    expect(sel).toHaveAttribute("name", "plan");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("keeps the ds-input class alongside a caller class", () => {
    render(<Select aria-label="x" className="extra"><option>a</option></Select>);
    const sel = screen.getByLabelText("x");
    expect(sel).toHaveClass("ds-input");
    expect(sel).toHaveClass("extra");
  });

  it("fires onChange with the chosen value", async () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Plan" defaultValue="basic" onChange={(e) => onChange(e.target.value)}>
        <option value="basic">Basic</option>
        <option value="pro">Pro</option>
      </Select>,
    );
    await userEvent.selectOptions(screen.getByLabelText("Plan"), "pro");
    expect(onChange).toHaveBeenCalledWith("pro");
  });
});
