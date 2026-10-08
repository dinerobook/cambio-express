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

const createTransfer = vi.fn();

vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return {
    ...real,
    createTransfer: (...a: unknown[]) => createTransfer(...a),
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
  });

  it("blocks an empty save and names what is missing", async () => {
    const user = userEvent.setup();
    renderPage();
    // Sender name / employee are also native `required`; drop the
    // native gate so the zod messages are what we are checking.
    screen.getByRole("button", { name: "Save transfer" })
      .closest("form")!.noValidate = true;
    await user.click(screen.getByRole("button", { name: "Save transfer" }));
    expect(await screen.findByText("Send amount must be > 0")).toBeInTheDocument();
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
});
