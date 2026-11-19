import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { Checkbox } from "./Checkbox";
import { Field } from "./Field";
import { Input } from "./Input";
import { MoneyInput } from "./MoneyInput";
import { Select } from "./Select";
import { Textarea } from "./Textarea";

describe("<Field>", () => {
  it("renders the label + child input", () => {
    render(
      <Field label="Email">
        <input type="email" />
      </Field>,
    );
    expect(screen.getByText("Email")).toBeInTheDocument();
  });

  it("renders the hint when provided", () => {
    render(
      <Field label="Email" hint="We never share this.">
        <input />
      </Field>,
    );
    expect(screen.getByText("We never share this.")).toBeInTheDocument();
  });

  it("renders the error message when provided", () => {
    render(
      <Field label="Email" error="Required.">
        <input />
      </Field>,
    );
    expect(screen.getByText("Required.")).toBeInTheDocument();
  });

  it("hides the label span when label is empty string", () => {
    render(
      <Field label="">
        <input data-testid="bare-input" />
      </Field>,
    );
    // The label wrapper element still exists, but the visible label
    // span doesn't render — useful for stacked controls with a
    // separate header.
    expect(screen.getByTestId("bare-input")).toBeInTheDocument();
  });

  it("labels any child, even one outside the kit", () => {
    render(
      <Field label="Code">
        <input />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Code" })).toBeInTheDocument();
  });

  // The hint and error used to sit inside the <label>, so they became
  // part of the control's name ("Email We never share this. Required.").
  it("names the control by its label alone and describes it by the hint and error", () => {
    render(
      <Field label="Email" hint="We never share this." error="Enter an email.">
        <Input type="email" />
      </Field>,
    );
    const box = screen.getByRole("textbox", { name: "Email" });
    expect(box).toHaveAccessibleDescription("We never share this. Enter an email.");
    expect(box).toHaveAttribute("aria-invalid", "true");
  });

  it("marks a highlighted field invalid without a message", () => {
    render(
      <Field label="Amount" highlight>
        <Input />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Amount" }))
      .toHaveAttribute("aria-invalid", "true");
  });

  it("draws one required mark, hidden from screen readers, and says aria-required", () => {
    render(
      <Field label="Full name" required>
        <Input />
      </Field>,
    );
    const box = screen.getByRole("textbox", { name: "Full name" });
    expect(box).toHaveAttribute("aria-required", "true");
    const mark = screen.getByText("*");
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });

  it("leaves a valid, optional field without aria flags", () => {
    render(
      <Field label="Notes" hint="Shown on the receipt.">
        <Textarea />
      </Field>,
    );
    const box = screen.getByRole("textbox", { name: "Notes" });
    expect(box).not.toHaveAttribute("aria-invalid");
    expect(box).not.toHaveAttribute("aria-required");
    expect(box).toHaveAccessibleDescription("Shown on the receipt.");
  });

  it("keeps a caller's own description and adds the field's", () => {
    render(
      <>
        <p id="own">Own note.</p>
        <Field label="Status" hint="Pick one.">
          <Select aria-describedby="own"><option>Open</option></Select>
        </Field>
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Status" }))
      .toHaveAccessibleDescription("Own note. Pick one.");
  });

  it("wires a checkbox to the field's hint", () => {
    render(
      <Field label="Reconciled" hint="The bank matched it.">
        <Checkbox>Batch is reconciled</Checkbox>
      </Field>,
    );
    expect(screen.getByRole("checkbox"))
      .toHaveAccessibleDescription("The bank matched it.");
  });

  // A MoneyInput used to render its own <label> inside the Field's.
  it("renders a MoneyInput inside it as a bare box, no nested label", () => {
    const { container } = render(
      <Field label="Send amount" error="Enter an amount.">
        <MoneyInput value={0} onChange={() => {}} />
      </Field>,
    );
    expect(container.querySelectorAll("label")).toHaveLength(1);
    const box = screen.getByRole("textbox", { name: "Send amount" });
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toHaveAccessibleDescription("Enter an amount.");
  });
});
