import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditTransfer from "./EditTransfer";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";

// Edit transfer form. Pinned here:
//   - The form hydrates from the stored transfer (date, sender,
//     company, amounts).
//   - Every field the full-row PUT replaces is hydrated, and saving
//     unchanged sends it all back (an edit used to blank the
//     sender's phone, address and DOB, the recipient's phone, the
//     commission and the notes).
//   - A cashier who has left stays selectable as "(former)", so an
//     edit keeps the attribution; with no stored employee, picking
//     one is required.
//   - Save PUTs the number-typed body to the right id, without a
//     federal_tax, then returns to the detail page.
//   - The server's refusal shows in the root alert.
//   - A load failure shows the ErrorState with a retry.

const updateTransfer = vi.fn();
const useTransfer = vi.fn();

const stored = {
  id: 9, send_date: "2026-10-01", company: "Maxi",
  service_type: "Money Transfer", sender_name: "Ana Ruiz",
  recipient_name: "Luis", country: "Guatemala", confirm_number: "C-77",
  send_amount: 200, fee: 6, federal_tax: 2, total_collected: 208,
  status: "Pending", batch_id: "B1", employee_name: "Tom",
  sender_phone: "5550001111", sender_phone_country: "+52",
  sender_address: "12 Main St", sender_dob: "1980-05-06",
  recipient_phone: "5559998888", commission: 1.5,
  status_notes: "called sender", internal_notes: "regular",
  employee_id: 7, customer_id: 41,
};

vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return {
    ...real,
    updateTransfer: (...a: unknown[]) => updateTransfer(...a),
    useTransfer: (...a: unknown[]) => useTransfer(...a),
    useEmployees: () => ({
      data: { employees: [{ id: 7, name: "Rosa Diaz" }] },
      isLoading: false, isError: false,
    }),
  };
});

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    useStoreInfo: () => ({ data: { store: { federal_tax_rate: 0.01 } } }),
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
        <MemoryRouter initialEntries={["/transfers/9/edit"]}>
          <Routes>
            <Route path="/transfers/:id/edit" element={<EditTransfer />} />
            <Route path="/transfers/:id" element={<div>detail page</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("EditTransfer", () => {
  beforeEach(() => {
    updateTransfer.mockReset();
    useTransfer.mockReset();
    useTransfer.mockReturnValue({
      data: { transfer: stored }, isLoading: false, isError: false,
      refetch: vi.fn(),
    });
  });

  it("hydrates the form from the stored transfer", async () => {
    renderPage();
    expect(await screen.findByDisplayValue("2026-10-01")).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveValue("Ana Ruiz");
    expect(screen.getByLabelText("Company")).toHaveValue("Maxi");
    expect(screen.getByLabelText("Status")).toHaveValue("Pending");
    expect(screen.getByLabelText("Country")).toHaveValue("Guatemala");
    expect(screen.getByLabelText(/^Send amount/)).toHaveValue("200");
    expect(screen.getByLabelText(/^Fee/)).toHaveValue("6");
    expect(screen.getByLabelText(/^Federal tax preview/)).toHaveValue("$2.00");
  });

  it("saves an untouched edit without losing any stored field", async () => {
    updateTransfer.mockResolvedValue({ transfer: stored });
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue("2026-10-01");
    expect(screen.getByLabelText("Employee")).toHaveValue("7");
    expect(screen.getByDisplayValue("12 Main St")).toBeInTheDocument();
    expect(screen.getByDisplayValue("5559998888")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateTransfer).toHaveBeenCalledTimes(1));
    expect(updateTransfer.mock.calls[0][1]).toMatchObject({
      sender_phone: "5550001111",
      sender_phone_country: "+52",
      sender_address: "12 Main St",
      sender_dob: "1980-05-06",
      recipient_phone: "5559998888",
      commission: 1.5,
      status_notes: "called sender",
      internal_notes: "regular",
      employee_id: 7,
      customer_id: 41,
    });
  });

  it("keeps a former employee's attribution on save", async () => {
    useTransfer.mockReturnValue({
      data: { transfer: { ...stored, employee_id: 3, employee_name: "Tom" } },
      isLoading: false, isError: false, refetch: vi.fn(),
    });
    updateTransfer.mockResolvedValue({ transfer: stored });
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue("2026-10-01");
    const select = screen.getByLabelText("Employee");
    expect(select).toHaveValue("3");
    expect(screen.getByRole("option", { name: "Tom (former)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateTransfer).toHaveBeenCalledTimes(1));
    expect(updateTransfer.mock.calls[0][1].employee_id).toBe(3);
  });

  it("requires an employee before saving", async () => {
    useTransfer.mockReturnValue({
      data: { transfer: { ...stored, employee_id: null } },
      isLoading: false, isError: false, refetch: vi.fn(),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue("2026-10-01");
    // Native `required` also guards the select; test the zod message.
    screen.getByRole("button", { name: "Save changes" }).closest("form")!.noValidate = true;
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Pick an employee")).toBeInTheDocument();
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it("PUTs numbers to this transfer, with no federal_tax, then opens the detail", async () => {
    updateTransfer.mockResolvedValue({ transfer: { ...stored, fee: 7.25 } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue("2026-10-01");
    const fee = screen.getByLabelText(/^Fee/);
    await user.clear(fee);
    await user.type(fee, "7.25");
    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2026-10-02" },
    });
    await user.selectOptions(screen.getByLabelText("Employee"), "7");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateTransfer).toHaveBeenCalledTimes(1));
    const [id, body] = updateTransfer.mock.calls[0];
    expect(id).toBe(9);
    expect(body).toMatchObject({
      send_date: "2026-10-02",
      company: "Maxi",
      status: "Pending",
      sender_name: "Ana Ruiz",
      send_amount: 200,
      fee: 7.25,
      confirm_number: "C-77",
      batch_id: "B1",
      employee_id: 7,
    });
    expect(body).not.toHaveProperty("federal_tax");
    expect(await screen.findByText("detail page")).toBeInTheDocument();
  });

  it("shows the server's refusal in the root alert", async () => {
    updateTransfer.mockRejectedValue(new ApiError(404, "Transfer not found", null));
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue("2026-10-01");
    await user.selectOptions(screen.getByLabelText("Employee"), "7");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Transfer not found")).toBeInTheDocument();
    expect(screen.queryByText("detail page")).not.toBeInTheDocument();
  });

  it("offers a retry when the transfer cannot be loaded", async () => {
    const refetch = vi.fn();
    useTransfer.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(500, "boom", null), refetch,
    });
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByText("boom")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });
});
