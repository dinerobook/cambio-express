import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BatchForm from "./BatchForm";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { todayIso } from "../lib/datetime";

// New / edit ACH batch form: what reaches the API (amount as a
// number, date as YYYY-MM-DD), server errors shown in place, an
// edit hydrates from the server row, and leaving a dirty form asks
// first. Create is blocked until a reference is typed.

const createBatch = vi.fn();
const updateBatch = vi.fn();
const useBatch = vi.fn();

vi.mock("../api/batches", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/batches")>();
  return {
    ...real,
    createBatch: (...a: unknown[]) => createBatch(...a),
    updateBatch: (...a: unknown[]) => updateBatch(...a),
    useBatch: (id: number | undefined) => useBatch(id),
  };
});

const existing = {
  id: 7, ach_date: "2026-09-30", company: "Maxi", batch_ref: "ACH-77",
  ach_amount: 1234.5, status: "Cleared", reconciled: true,
  transfer_dates: "2026-09-25..29", notes: "from statement",
  transfers_total: 1200, variance: 34.5, transfer_count: 3,
  expected_ach: 1200, card_credit: 0, card_credit_from: "",
  card_credit_next: 0, card_credit_next_to: "",
  payout_credit: 0, payout_credit_next: 0,
};

function renderForm(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/batches/new" element={<BatchForm />} />
            <Route path="/batches/:id/edit" element={<BatchForm />} />
            <Route path="/batches" element={<div>batches list</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("BatchForm", () => {
  beforeEach(() => {
    createBatch.mockReset();
    updateBatch.mockReset();
    useBatch.mockReset();
    useBatch.mockReturnValue({ data: undefined, isLoading: false });
  });

  it("blocks Create until a batch reference is typed", async () => {
    renderForm("/batches/new");
    const submit = screen.getByRole("button", { name: "Create batch" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Batch reference"), "ACH-1");
    expect(submit).toBeEnabled();
  });

  it("creates a batch with a numeric amount and today's date", async () => {
    createBatch.mockResolvedValue({ batch: existing });
    renderForm("/batches/new");
    await userEvent.type(screen.getByLabelText("Batch reference"), "ACH-1");
    await userEvent.type(screen.getByLabelText(/^ACH amount/), "1234.50");
    await userEvent.selectOptions(screen.getByLabelText("Company"), "Barri");
    await userEvent.click(screen.getByRole("button", { name: "Create batch" }));

    await waitFor(() => expect(createBatch).toHaveBeenCalledTimes(1));
    expect(createBatch).toHaveBeenCalledWith({
      ach_date: todayIso(),
      company: "Barri",
      batch_ref: "ACH-1",
      ach_amount: 1234.5,
      transfer_dates: "",
      status: "Pending",
      reconciled: false,
      notes: "",
    });
    expect(await screen.findByText("batches list")).toBeInTheDocument();
    expect(screen.getByText("Batch created.")).toBeInTheDocument();
  });

  it("shows the server's error and stays on the form when create fails", async () => {
    createBatch.mockRejectedValue(
      new ApiError(409, "Batch reference already exists.", {
        detail: { field: "batch_ref" },
      }),
    );
    renderForm("/batches/new");
    await userEvent.type(screen.getByLabelText("Batch reference"), "DUP");
    await userEvent.click(screen.getByRole("button", { name: "Create batch" }));
    expect(await screen.findByText("Batch reference already exists."))
      .toBeInTheDocument();
    expect(screen.queryByText("batches list")).not.toBeInTheDocument();
    // The form is usable again for a retry.
    expect(screen.getByRole("button", { name: "Create batch" })).toBeEnabled();
  });

  it("falls back to a generic message for a non-API failure", async () => {
    createBatch.mockRejectedValue(new Error("network down"));
    renderForm("/batches/new");
    await userEvent.type(screen.getByLabelText("Batch reference"), "X1");
    await userEvent.click(screen.getByRole("button", { name: "Create batch" }));
    expect(await screen.findByText("Could not save batch.")).toBeInTheDocument();
  });

  it("hydrates an edit from the server row and PUTs the changes", async () => {
    useBatch.mockReturnValue({ data: { batch: existing }, isLoading: false });
    updateBatch.mockResolvedValue({ batch: existing });
    renderForm("/batches/7/edit");

    expect(screen.getByText("Edit batch #7")).toBeInTheDocument();
    expect(screen.getByLabelText("Batch reference")).toHaveValue("ACH-77");
    expect(screen.getByLabelText("Company")).toHaveValue("Maxi");
    expect(screen.getByLabelText("Status")).toHaveValue("Cleared");
    expect(screen.getByLabelText(/^ACH amount/)).toHaveValue("1234.5");
    expect(screen.getByRole("checkbox", { name: /Batch is reconciled/ })).toBeChecked();

    await userEvent.selectOptions(screen.getByLabelText("Status"), "Returned");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateBatch).toHaveBeenCalledTimes(1));
    expect(updateBatch).toHaveBeenCalledWith(7, {
      ach_date: "2026-09-30",
      company: "Maxi",
      batch_ref: "ACH-77",
      ach_amount: 1234.5,
      transfer_dates: "2026-09-25..29",
      status: "Returned",
      reconciled: true,
      notes: "from statement",
    });
    expect(createBatch).not.toHaveBeenCalled();
    expect(await screen.findByText("Batch updated.")).toBeInTheDocument();
  });

  it("shows the expected ACH with the debit card credit on an edit", () => {
    useBatch.mockReturnValue({
      data: { batch: {
        ...existing, transfers_total: 303, card_credit: 106,
        payout_credit: 40,
        card_credit_from: "ACH-76", expected_ach: 157, ach_amount: 150,
        variance: -7, transfer_count: 1,
      } },
      isLoading: false,
    });
    renderForm("/batches/7/edit");
    expect(screen.getByText("Expected ACH", { selector: "h2" })).toBeInTheDocument();
    expect(screen.getByText("$303.00")).toBeInTheDocument();
    expect(screen.getByText("1 transfer")).toBeInTheDocument();
    expect(screen.getByText("-$106.00")).toBeInTheDocument();
    expect(screen.getByText("-$40.00")).toBeInTheDocument();
    expect(screen.getAllByText("From batch ACH-76")).toHaveLength(2);
    expect(screen.getByText("$157.00")).toBeInTheDocument();
    expect(screen.getByText("-$7.00")).toBeInTheDocument();
  });

  it("says where this batch's own card sends get credited", () => {
    useBatch.mockReturnValue({
      data: { batch: { ...existing, card_credit_next: 52.5, card_credit_next_to: "ACH-78" } },
      isLoading: false,
    });
    renderForm("/batches/7/edit");
    expect(screen.getByText(/\$52\.50 paid by debit card on this batch is credited on batch ACH-78\./))
      .toBeInTheDocument();
  });

  it("calls a card credit pending while the company has no next batch", () => {
    useBatch.mockReturnValue({
      data: { batch: { ...existing, card_credit_next: 52.5 } },
      isLoading: false,
    });
    renderForm("/batches/7/edit");
    expect(screen.getByText(/credited on this company's next ACH, once it is entered/))
      .toBeInTheDocument();
    expect(screen.getAllByText("None from a previous batch")).toHaveLength(2);
  });

  it("names both card sends and payouts credited on the next batch", () => {
    useBatch.mockReturnValue({
      data: { batch: {
        ...existing, card_credit_next: 52.5, payout_credit_next: 60,
        card_credit_next_to: "ACH-78",
      } },
      isLoading: false,
    });
    renderForm("/batches/7/edit");
    expect(screen.getByText(
      "$52.50 paid by debit card and $60.00 paid out on this batch are credited on batch ACH-78.",
    )).toBeInTheDocument();
  });

  it("shows no expected ACH on a new batch", () => {
    renderForm("/batches/new");
    expect(screen.queryByText("Expected ACH", { selector: "h2" })).not.toBeInTheDocument();
  });

  it("leaves straight away on Cancel when nothing changed", async () => {
    renderForm("/batches/new");
    // Clean form: Cancel leaves straight away.
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("batches list")).toBeInTheDocument();
  });

  it("confirms before discarding a dirty form", async () => {
    renderForm("/batches/new");
    await userEvent.type(screen.getByLabelText("Batch reference"), "HALF");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/unsaved edits on this batch/)).toBeInTheDocument();
    expect(screen.queryByText("batches list")).not.toBeInTheDocument();
    expect(createBatch).not.toHaveBeenCalled();
  });
});
