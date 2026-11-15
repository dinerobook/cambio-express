import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditFilterFields } from "./AuditFilterFields";
import { setLanguage } from "../i18n";

// The one Target / Action pair over every audit feed (store Audit log,
// a person's Activity, the superadmin store page).

afterEach(() => setLanguage("en"));

describe("<AuditFilterFields>", () => {
  it("reports each pick to the page", async () => {
    const onTarget = vi.fn();
    const onAction = vi.fn();
    render(<AuditFilterFields target="" action="" onTarget={onTarget} onAction={onAction} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Target" }), "transfer");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action" }), "delete");
    expect(onTarget).toHaveBeenCalledWith("transfer");
    expect(onAction).toHaveBeenCalledWith("delete");
  });

  it("takes a fuller accessible name when the page has several lists", () => {
    render(
      <AuditFilterFields
        target="batch" action="lock" onTarget={() => {}} onAction={() => {}}
        targetAria="Activity target" actionAria="Activity action"
      />,
    );
    expect(screen.getByRole("combobox", { name: "Activity target" })).toHaveValue("batch");
    expect(screen.getByRole("combobox", { name: "Activity action" })).toHaveValue("lock");
  });

  it("says Target the same way in Spanish everywhere", () => {
    setLanguage("es");
    render(<AuditFilterFields target="" action="" onTarget={() => {}} onAction={() => {}} />);
    expect(screen.getByText("Objeto")).toBeInTheDocument();
    expect(screen.getByText("Acción")).toBeInTheDocument();
  });
});
