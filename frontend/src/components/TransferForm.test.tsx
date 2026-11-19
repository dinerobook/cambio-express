import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TransferForm, { type TransferFormProps } from "./TransferForm";
import { renderRoute, renderRouteWithGuard } from "../test/renderRoute";
import { ApiError } from "../lib/api";
import { newTransferValues, type TransferFormValues } from "../lib/transferForm";

// The one money transfer form behind New transfer and Edit transfer.
// The page tests (NewTransfer / EditTransfer) pin each page's flow;
// pinned here is what the shared form owns for both:
//   - the employee roster: a saved employee who left stays selectable
//     as "(former)" (only when off the roster), the required-employee
//     line, and the roster's load failure / empty roster messages;
//   - a newer copy of the transfer starts the form over from it, while
//     a re-render with the same values keeps what was typed;
//   - the store's lists move company and country only when asked
//     (a new transfer), never on an edit;
//   - save: success opens the saved transfer, a server refusal or a
//     plain failure stays on the form with its message;
//   - Cancel goes where the page says, asking first when there are edits.

const roster = vi.fn();
const choices = vi.fn();

vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return {
    ...real,
    useTransferChoices: () => choices(),
    useEmployees: () => roster(),
  };
});

vi.mock("../api/customers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/customers")>();
  return {
    ...real,
    useCustomerSearch: () => ({ data: undefined, isFetching: false }),
  };
});

const ROSTER = [{ id: 7, name: "Rosa Diaz" }];

function filled(over: Partial<TransferFormValues> = {}): TransferFormValues {
  return {
    ...newTransferValues(),
    send_date: "2026-10-01",
    company: "Maxi",
    country: "Guatemala",
    sender_name: "Ana Ruiz",
    send_amount: 200,
    fee: 6,
    employee_id: 7,
    ...over,
  };
}

function props(over: Partial<TransferFormProps> = {}): TransferFormProps {
  return {
    initialValues: filled(),
    storeId: 1,
    submitLabel: "Save it",
    cancelTo: "/transfers",
    savedMessage: "Saved!",
    failedMessage: "Could not save",
    save: vi.fn().mockResolvedValue({ transfer: { id: 55 } }),
    ...over,
  };
}

describe("TransferForm", () => {
  beforeEach(() => {
    roster.mockReturnValue({
      data: { employees: ROSTER }, isLoading: false, isError: false,
    });
    choices.mockReturnValue({
      data: {
        companies: ["Intermex", "Maxi"], countries: ["Mexico", "Guatemala"],
        federal_tax_rate: 0.01,
      },
      isLoading: false, isError: false, refetch: vi.fn(),
    });
  });

  it("keeps a saved employee who left as (former), and only then", () => {
    const { unmount } = renderRoute(
      <TransferForm {...props({
        initialValues: filled({ employee_id: 3 }),
        keepEmployee: { id: 3, name: "Tom" },
      })} />,
    );
    expect(screen.getByLabelText("Employee")).toHaveValue("3");
    expect(screen.getByRole("option", { name: "Tom (former)" })).toBeInTheDocument();
    unmount();

    // Still on the roster: listed once, under their own name.
    renderRoute(<TransferForm {...props({ keepEmployee: { id: 7, name: "Rosa Diaz" } })} />);
    expect(screen.getAllByRole("option", { name: /Rosa Diaz/ })).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /\(former\)/ })).toBeNull();
  });

  it("shows the saved employee when the roster arrives after the form", async () => {
    // Seen in Chrome: an uncontrolled select read "— Select —" over a
    // saved employee when the roster loaded after the transfer (jsdom
    // does not reproduce the browser's half, so the page screenshots
    // cover it; this pins the value and the save).
    roster.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const save = vi.fn().mockResolvedValue({ transfer: { id: 55 } });
    const user = userEvent.setup();
    function Page() {
      const [, bump] = useState(0);
      return (
        <>
          <button type="button" onClick={() => bump((n) => n + 1)}>roster loaded</button>
          <TransferForm {...props({ save })} />
        </>
      );
    }
    renderRoute(<Page />);
    roster.mockReturnValue({ data: { employees: ROSTER }, isLoading: false, isError: false });
    await user.click(screen.getByRole("button", { name: "roster loaded" }));
    expect(screen.getByLabelText("Employee")).toHaveValue("7");
    expect(screen.getByRole("option", { name: "Rosa Diaz" })).toHaveProperty("selected", true);
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Employee"), "");
    await user.selectOptions(screen.getByLabelText("Employee"), "7");
    await user.click(screen.getByRole("button", { name: "Save it" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].employee_id).toBe(7);
  });

  it("says the employee is required", () => {
    renderRoute(<TransferForm {...props()} />);
    expect(screen.getByText("Required: the cashier who took the cash for this transfer."))
      .toBeInTheDocument();
  });

  it("says when the roster cannot load", () => {
    roster.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderRoute(<TransferForm {...props()} />);
    expect(screen.getByText("Couldn't load the employee list. Add cashiers under Settings → Team.")).toBeInTheDocument();
  });

  it("says when the store has no employees", () => {
    roster.mockReturnValue({ data: { employees: [] }, isLoading: false, isError: false });
    renderRoute(<TransferForm {...props()} />);
    expect(screen.getByText(/No active employees/i)).toBeInTheDocument();
  });

  it("starts over from a newer copy of the transfer, not from a re-render", async () => {
    const user = userEvent.setup();
    const first = props();
    // The page re-renders with the same values, or hands a newer copy.
    function Page() {
      const [values, setValues] = useState(first.initialValues);
      const [, bump] = useState(0);
      return (
        <>
          <button type="button" onClick={() => bump((n) => n + 1)}>re-render</button>
          <button
            type="button"
            onClick={() => setValues(filled({ sender_name: "Ana Ruiz-Paz", fee: 9 }))}
          >
            newer copy
          </button>
          <TransferForm {...first} initialValues={values} />
        </>
      );
    }
    renderRoute(<Page />);
    const name = screen.getByLabelText("Full name");
    await user.clear(name);
    await user.type(name, "Typed");

    await user.click(screen.getByRole("button", { name: "re-render" }));
    expect(screen.getByLabelText("Full name")).toHaveValue("Typed");

    await user.click(screen.getByRole("button", { name: "newer copy" }));
    expect(screen.getByLabelText("Full name")).toHaveValue("Ana Ruiz-Paz");
    expect(screen.getByLabelText(/^Fee/)).toHaveValue("9");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("moves company and country onto the store's lists only when asked", () => {
    const { unmount } = renderRoute(
      <TransferForm {...props({ initialValues: newTransferValues(), startOnStoreLists: true })} />,
    );
    expect(screen.getByLabelText("Company")).toHaveValue("Intermex");
    expect(screen.getByLabelText("Country")).toHaveValue("Mexico");
    unmount();

    renderRoute(<TransferForm {...props()} />);
    expect(screen.getByLabelText("Company")).toHaveValue("Maxi");
    expect(screen.getByLabelText("Country")).toHaveValue("Guatemala");
  });

  it("saves, says so and opens the saved transfer", async () => {
    const save = vi.fn().mockResolvedValue({ transfer: { id: 55 } });
    const user = userEvent.setup();
    renderRoute(<TransferForm {...props({ save })} />);
    await user.click(screen.getByRole("button", { name: "Save it" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({
      company: "Maxi", sender_name: "Ana Ruiz", send_amount: 200, fee: 6, employee_id: 7,
    });
    expect(await screen.findByText("Navigated to /transfers/55")).toBeInTheDocument();
    expect(screen.getByText("Saved!")).toBeInTheDocument();
  });

  it("stays on the form with the server's refusal", async () => {
    const save = vi.fn().mockRejectedValue(new ApiError(422, "Payout cannot carry a fee", null));
    const user = userEvent.setup();
    renderRoute(<TransferForm {...props({ save })} />);
    await user.click(screen.getByRole("button", { name: "Save it" }));
    expect(await screen.findByText("Payout cannot carry a fee")).toBeInTheDocument();
    expect(screen.queryByText(/Navigated to/)).toBeNull();
  });

  it("falls back to the page's message for a plain failure", async () => {
    const save = vi.fn().mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    renderRoute(<TransferForm {...props({ save })} />);
    await user.click(screen.getByRole("button", { name: "Save it" }));
    expect(await screen.findByText("Could not save")).toBeInTheDocument();
  });

  it("does not save without an employee", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    renderRoute(<TransferForm {...props({ save, initialValues: filled({ employee_id: undefined as unknown as number }) })} />);
    screen.getByRole("button", { name: "Save it" }).closest("form")!.noValidate = true;
    await user.click(screen.getByRole("button", { name: "Save it" }));
    expect(await screen.findByText("Pick an employee")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("cancels to the page's destination, asking first when edited", async () => {
    const user = userEvent.setup();
    const { router } = renderRouteWithGuard(
      <TransferForm {...props({ cancelTo: "/transfers/9" })} />,
      { path: "/transfers/9/edit" },
    );
    await user.type(screen.getByLabelText("Confirmation #"), "X");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(router.state.location.pathname).toBe("/transfers/9/edit");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Leave" }));
    expect(await screen.findByText("Navigated to /transfers/9")).toBeInTheDocument();
  });

  it("cancels without asking when nothing changed", async () => {
    const user = userEvent.setup();
    renderRouteWithGuard(<TransferForm {...props()} />, { path: "/transfers/new" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Navigated to /transfers")).toBeInTheDocument();
  });
});
