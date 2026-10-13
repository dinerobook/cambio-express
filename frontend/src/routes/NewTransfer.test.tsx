import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import NewTransfer from "./NewTransfer";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";

// New transfer form. Pinned here:
//   - Required fields block the save and show their message.
//   - A valid form sends numbers (not strings), the ISO date and the
//     sender/recipient fields to createTransfer — and never a
//     federal_tax (the server computes it, CLAUDE.md invariant 9).
//   - The federal-tax preview follows the store rate, and is zero for
//     exempt services / domestic recipients.
//   - The server's message lands in the root Alert; success goes to
//     the new transfer.
//   - Every save attempt from one form carries the SAME save key, so
//     pressing Save again after an error can never log the transfer
//     twice; a new form gets a new key.
//   - "Paid by debit card" sends payment_method "debit_card" (cash by
//     default) and previews no remittance tax (cash only since
//     2026-01-01); a Payout hides the fee and the card box, swaps the
//     party / amount names, and always sends cash with no fee.
//   - Company and country are the store's own lists from Settings →
//     General (owner report 2026-10-13: the form had its own list, so
//     it did not match the MSB daily book's companies).

const createTransfer = vi.fn();
const DEFAULT_COUNTRIES = [
  "United States", "Mexico", "Guatemala", "El Salvador", "Honduras",
  "Dominican Republic", "Colombia", "Ecuador", "Peru", "Other",
];
const refetchChoices = vi.fn();
const choices = vi.fn();
function storeLists(companies: string[], countries = DEFAULT_COUNTRIES) {
  choices.mockReturnValue({
    data: { companies, countries },
    isLoading: false, isError: false, refetch: refetchChoices,
  });
}

vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return {
    ...real,
    createTransfer: (...a: unknown[]) => createTransfer(...a),
    useTransferChoices: () => choices(),
    useEmployees: () => ({
      data: { employees: [{ id: 7, name: "Rosa Diaz" }, { id: 8, name: "Tom" }] },
      isLoading: false, isError: false,
    }),
  };
});

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    useStoreInfo: () => ({
      data: { store: { federal_tax_rate: 0.01, store_hours: [], timezone: "" } },
    }),
  };
});

vi.mock("../api/customers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/customers")>();
  return {
    ...real,
    useCustomerSearch: () => ({ data: undefined, isFetching: false }),
  };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/transfers/new"]}>
          <Routes>
            <Route path="/transfers/new" element={<NewTransfer />} />
            <Route path="/transfers/:id" element={<div>detail page</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(screen.getByLabelText("Date"), {
    target: { value: "2026-10-05" },
  });
  await user.type(screen.getByLabelText("Full name"), "Maria Lopez");
  await user.type(screen.getByLabelText("Recipient name"), "Juan Garcia");
  await user.type(screen.getByLabelText(/^Send amount/), "100");
  await user.type(screen.getByLabelText(/^Fee/), "5.50");
  await user.selectOptions(screen.getByLabelText("Employee"), "7");
}

describe("NewTransfer", () => {
  beforeEach(() => {
    createTransfer.mockReset();
    refetchChoices.mockReset();
    storeLists(["Intermex", "Maxi", "Sigue"]);
  });

  it("blocks an empty save and names what is missing", async () => {
    const user = userEvent.setup();
    renderPage();
    // Sender name / employee are also native `required`; drop the
    // native gate so the zod messages are what we are checking.
    screen.getByRole("button", { name: "Save transfer" })
      .closest("form")!.noValidate = true;
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    expect(await screen.findByText("Amount must be > 0")).toBeInTheDocument();
    expect(screen.getByText("Pick an employee")).toBeInTheDocument();
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("sends numbers, ISO date and customer fields, with no federal_tax", async () => {
    createTransfer.mockResolvedValue({ transfer: { id: 41 } });
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    await user.type(screen.getByLabelText("Phone"), "5551112222");
    await user.type(screen.getByLabelText("Confirmation #"), "ABC123");
    await user.click(screen.getByRole("button", { name: "Save transfer" }));

    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    const body = createTransfer.mock.calls[0][0];
    expect(body).toMatchObject({
      send_date: "2026-10-05",
      company: "Intermex",
      service_type: "Money Transfer",
      status: "Sent",
      sender_name: "Maria Lopez",
      sender_phone_country: "+1",
      sender_phone: "5551112222",
      recipient_name: "Juan Garcia",
      country: "Mexico",
      send_amount: 100,
      fee: 5.5,
      confirm_number: "ABC123",
      employee_id: 7,
      customer_id: null,
    });
    expect(body).not.toHaveProperty("federal_tax");
    expect(await screen.findByText("detail page")).toBeInTheDocument();
  });

  it("shows the server's message in the root alert and stays on the form", async () => {
    createTransfer.mockRejectedValue(
      new ApiError(422, "Store is closed right now", null),
    );
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    expect(await screen.findByText("Store is closed right now")).toBeInTheDocument();
    expect(screen.queryByText("detail page")).not.toBeInTheDocument();
  });

  it("retries with the same save key after a failed save", async () => {
    createTransfer
      .mockRejectedValueOnce(new ApiError(500, "Internal Server Error", null))
      .mockResolvedValueOnce({ transfer: { id: 42 } });
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    const save = screen.getByRole("button", { name: "Save transfer" });
    await user.click(save);
    expect(await screen.findByText("Internal Server Error")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save transfer" }));

    expect(await screen.findByText("detail page")).toBeInTheDocument();
    expect(createTransfer).toHaveBeenCalledTimes(2);
    const [first, second] = createTransfer.mock.calls.map((c) => c[1]);
    expect(typeof first).toBe("string");
    expect(first).not.toBe("");
    expect(second).toBe(first);
  });

  it("gives each new form its own save key", async () => {
    createTransfer.mockResolvedValue({ transfer: { id: 43 } });
    const user = userEvent.setup();
    const first = renderPage();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    await screen.findByText("detail page");
    first.unmount();

    renderPage();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(2));
    const [a, b] = createTransfer.mock.calls.map((c) => c[1]);
    expect(a).not.toBe(b);
  });

  it("falls back to a generic message for a non-API failure", async () => {
    createTransfer.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    expect(
      await screen.findByText("Could not save the transfer. Please try again."),
    ).toBeInTheDocument();
  });

  it("previews federal tax from the store rate, zero when exempt", async () => {
    const user = userEvent.setup();
    renderPage();
    const preview = screen.getByLabelText(/^Federal tax preview/) as HTMLInputElement;
    await user.type(screen.getByLabelText(/^Send amount/), "200");
    expect(preview.value).toBe("$2.00");

    await user.selectOptions(screen.getByLabelText("Service"), "Bill Payment");
    expect(preview.value).toBe("$0.00");
    expect(screen.getByText(/Exempt — Bill Payment service/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Service"), "Money Transfer");
    await user.selectOptions(screen.getByLabelText("Country"), "United States");
    expect(preview.value).toBe("$0.00");
    expect(screen.getByText(/Exempt — domestic recipient/)).toBeInTheDocument();
  });

  it("sends cash unless Paid by debit card is ticked", async () => {
    createTransfer.mockResolvedValue({ transfer: { id: 42 } });
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    expect(createTransfer.mock.calls[0][0]).toMatchObject({ payment_method: "cash" });
  });

  it("sends a debit card send with its fee and no remittance tax", async () => {
    createTransfer.mockResolvedValue({ transfer: { id: 43 } });
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    expect((screen.getByLabelText(/^Federal tax preview/) as HTMLInputElement).value)
      .toBe("$1.00");
    await user.click(screen.getByRole("checkbox", { name: /Paid by debit card/ }));
    // Since 2026-01-01 the 1% remittance tax is on cash sends only.
    expect((screen.getByLabelText(/^Federal tax preview/) as HTMLInputElement).value)
      .toBe("$0.00");
    expect(screen.getByText(/Exempt — paid by debit card/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    expect(createTransfer.mock.calls[0][0]).toMatchObject({
      payment_method: "debit_card", send_amount: 100, fee: 5.5,
    });
  });

  it("logs a payout: cash out, no fee, no tax, names swapped", async () => {
    createTransfer.mockResolvedValue({ transfer: { id: 44 } });
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    // Ticked first, then Payout picked: the card box goes and the
    // value falls back to cash, the typed fee to 0.
    await user.click(screen.getByRole("checkbox", { name: /Paid by debit card/ }));
    await user.selectOptions(screen.getByLabelText("Service"), "Payout");

    expect(screen.queryByRole("checkbox", { name: /Paid by debit card/ }))
      .not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Fee/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Amount paid out/)).toBeInTheDocument();
    expect(screen.getByText("Recipient (paid here)")).toBeInTheDocument();
    expect(screen.getByText("Sent by")).toBeInTheDocument();
    expect(screen.getByLabelText("Sent from")).toBeInTheDocument();
    expect((screen.getByLabelText(/^Federal tax preview/) as HTMLInputElement).value)
      .toBe("$0.00");
    expect(screen.getByText(/Exempt — Payout service/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    expect(createTransfer.mock.calls[0][0]).toMatchObject({
      service_type: "Payout", payment_method: "cash", fee: 0, send_amount: 100,
    });
  });

  it("shows the server's refusal of a payout rule", async () => {
    createTransfer.mockRejectedValue(new ApiError(
      422, "A payout has no fee: the recipient is paid the full amount.", null,
    ));
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    await user.selectOptions(screen.getByLabelText("Service"), "Payout");
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    expect(await screen.findByText(/A payout has no fee/)).toBeInTheDocument();
    expect(screen.queryByText("detail page")).not.toBeInTheDocument();
  });

  it("offers exactly the store's companies from Settings", async () => {
    createTransfer.mockResolvedValue({ transfer: { id: 45 } });
    const user = userEvent.setup();
    renderPage();
    const company = screen.getByLabelText("Company") as HTMLSelectElement;
    expect([...company.options].map((o) => o.value))
      .toEqual(["Intermex", "Maxi", "Sigue"]);
    // The first company on the store's list is the starting pick.
    expect(company.value).toBe("Intermex");
    await fillValid(user);
    await user.selectOptions(company, "Sigue");
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    expect(createTransfer.mock.calls[0][0]).toMatchObject({ company: "Sigue" });
  });

  it("offers the store's countries and starts on its first without Mexico", async () => {
    storeLists(["Barri"], ["Cuba", "Peru"]);
    createTransfer.mockResolvedValue({ transfer: { id: 46 } });
    const user = userEvent.setup();
    renderPage();
    const country = screen.getByLabelText("Country") as HTMLSelectElement;
    expect([...country.options].map((o) => o.value)).toEqual(["Cuba", "Peru"]);
    expect(country.value).toBe("Cuba");
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    expect(createTransfer.mock.calls[0][0]).toMatchObject({
      company: "Barri", country: "Cuba",
    });
  });

  it("starts on Mexico while the store's list has it", () => {
    renderPage();
    expect(screen.getByLabelText("Country")).toHaveValue("Mexico");
  });

  it("says where to add a company when none is switched on, and won't save", async () => {
    storeLists([]);
    const user = userEvent.setup();
    renderPage();
    // The hint is part of the field's label.
    expect(screen.getByLabelText(/^Company/)).toBeDisabled();
    expect(screen.getByText(/No money transfer companies are switched on/))
      .toBeInTheDocument();
    expect(screen.getByText("Settings → General")).toBeInTheDocument();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    expect(await screen.findByText("Pick a company")).toBeInTheDocument();
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("offers a retry when the store's lists cannot load", async () => {
    choices.mockReturnValue({
      data: undefined, isLoading: false, isError: true, refetch: refetchChoices,
    });
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByText("Could not load the store's companies and countries."))
      .toBeInTheDocument();
    expect(screen.getByLabelText("Company")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(refetchChoices).toHaveBeenCalled();
  });

  it("does not count loading the store's lists as an unsaved edit", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows only the store's countries, none of the old built-in ones", () => {
    storeLists(["Intermex"], ["Mexico", "Peru"]);
    renderPage();
    // The country picker only ever shows the store's list.
    expect([...(screen.getByLabelText("Country") as HTMLSelectElement).options]
      .map((o) => o.value)).toEqual(["Mexico", "Peru"]);
  });
});
