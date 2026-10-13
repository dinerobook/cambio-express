import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SenderAutocomplete from "./SenderAutocomplete";
import { Card } from "./ui";
import type { CustomerRow } from "../api/customers";

// The sender name's existing-customers list on the transfer forms.
// Owner report 2026-10-13: the list opened BEHIND the next card on the
// form, so no customer could be picked. Pinned here:
//   - the list renders outside the field and the card that holds it
//     (a portal on <body>, like the shared date field's calendar), so
//     no later card can paint over it, and its rows can be clicked;
//   - picking by mouse or keyboard fills the form through onPick and
//     closes the list;
//   - fewer than 2 letters shows nothing; Escape and a click elsewhere
//     close it; typing again clears the picked customer.

const search = vi.fn();
vi.mock("../api/customers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/customers")>();
  return { ...real, useCustomerSearch: (q: string) => search(q) };
});

const maria: CustomerRow = {
  id: 11, full_name: "Maria Lopez", dob: "1980-01-02", address: "1 Main",
  phone_country: "+1", phone_number: "5551112222",
  home_store_id: 7, home_store_name: "North",
};
const mario: CustomerRow = {
  ...maria, id: 12, full_name: "Mario Ruiz", phone_number: "",
  home_store_name: "",
};

function Form({ onPick = vi.fn(), onClear = vi.fn() }) {
  const [v, setV] = useState("");
  return (
    <>
      <Card>
        <label>
          Full name
          <SenderAutocomplete
            value={v}
            onChange={setV}
            onPick={(row) => { setV(row.full_name); onPick(row); }}
            onClearPickedId={onClear}
          />
        </label>
      </Card>
      {/* The card that used to cover the list. */}
      <Card><p>Recipient card</p></Card>
    </>
  );
}

beforeEach(() => {
  search.mockReset().mockReturnValue({
    data: { matches: [maria], suggestions: [mario] }, isFetching: false,
  });
});

describe("SenderAutocomplete", () => {
  it("opens the list outside the form's cards and picks a click", async () => {
    const onPick = vi.fn();
    const { container } = render(<Form onPick={onPick} />);
    await userEvent.type(screen.getByLabelText("Full name"), "Ma");
    const list = await screen.findByRole("listbox", { name: "Existing customers" });
    // Not inside the page's cards: nothing on the form can cover it.
    expect(container.contains(list)).toBe(false);
    expect(document.body.contains(list)).toBe(true);
    expect(within(list).getByText("Matches")).toBeInTheDocument();
    expect(within(list).getByText("Suggestions")).toBeInTheDocument();
    expect(within(list).getByText("· from North")).toBeInTheDocument();

    await userEvent.click(within(list).getByRole("option", { name: /Maria Lopez/ }));
    expect(onPick).toHaveBeenCalledWith(maria);
    expect(screen.getByLabelText("Full name")).toHaveValue("Maria Lopez");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  });

  it("picks with the arrow keys and Enter", async () => {
    const onPick = vi.fn();
    render(<Form onPick={onPick} />);
    await userEvent.type(screen.getByLabelText("Full name"), "Ma");
    await screen.findByRole("listbox");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("option", { name: /Mario Ruiz/ }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(mario);
  });

  it("keeps the caret in the name field while the list is open", async () => {
    render(<Form />);
    const input = screen.getByLabelText("Full name");
    await userEvent.type(input, "Mar");
    await screen.findByRole("listbox");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Mar");
  });

  it("shows nothing under 2 letters", async () => {
    render(<Form />);
    await userEvent.type(screen.getByLabelText("Full name"), "M");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes on Escape and on a click elsewhere", async () => {
    render(<Form />);
    await userEvent.type(screen.getByLabelText("Full name"), "Ma");
    await screen.findByRole("listbox");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());

    await userEvent.type(screen.getByLabelText("Full name"), "r");
    await screen.findByRole("listbox");
    await userEvent.click(screen.getByText("Recipient card"));
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  });

  it("says when nothing matches, and while it searches", async () => {
    search.mockReturnValue({ data: { matches: [], suggestions: [] }, isFetching: false });
    const { rerender } = render(<Form />);
    await userEvent.type(screen.getByLabelText("Full name"), "Zz");
    expect(await screen.findByText("No matches.")).toBeInTheDocument();
    search.mockReturnValue({ data: undefined, isFetching: true });
    rerender(<Form />);
    await userEvent.type(screen.getByLabelText("Full name"), "z");
    expect(await screen.findByText("Searching…")).toBeInTheDocument();
  });

  it("clears the picked customer when the name is typed again", async () => {
    const onClear = vi.fn();
    render(<Form onClear={onClear} />);
    await userEvent.type(screen.getByLabelText("Full name"), "M");
    expect(onClear).toHaveBeenCalled();
  });
});
