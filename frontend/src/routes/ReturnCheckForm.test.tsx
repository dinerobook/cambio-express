import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ReturnCheckForm from "./ReturnCheckForm";
import { RETURN_CHECK_STATUS_TONES, type ReturnCheckRow } from "../api/returnChecks";
import { Pill, ToastProvider, type PillTone } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { todayIso } from "../lib/datetime";
import { TEST_ADMIN } from "../test/setup";

// Returned-check form. New: the body that reaches the API (amounts
// as numbers, date as YYYY-MM-DD). Edit: recovery payments (record
// / remove) and the write-off transitions (loss / fraud / reopen),
// every one of which asks first. Status uses the shared tone map and
// Remove needs return_checks.delete.

const createReturnCheck = vi.fn();
const updateReturnCheck = vi.fn();
const markLoss = vi.fn();
const markFraud = vi.fn();
const reopenReturnCheck = vi.fn();
const createReturnCheckPayment = vi.fn();
const deleteReturnCheckPayment = vi.fn();
const useReturnCheck = vi.fn();
const useReturnCheckPayments = vi.fn();
const refetch = vi.fn();

vi.mock("../api/returnChecks", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/returnChecks")>();
  return {
    ...real,
    createReturnCheck: (...a: unknown[]) => createReturnCheck(...a),
    updateReturnCheck: (...a: unknown[]) => updateReturnCheck(...a),
    markLoss: (...a: unknown[]) => markLoss(...a),
    markFraud: (...a: unknown[]) => markFraud(...a),
    reopenReturnCheck: (...a: unknown[]) => reopenReturnCheck(...a),
    createReturnCheckPayment: (...a: unknown[]) => createReturnCheckPayment(...a),
    deleteReturnCheckPayment: (...a: unknown[]) => deleteReturnCheckPayment(...a),
    useReturnCheck: (id: number | undefined) => useReturnCheck(id),
    useReturnCheckPayments: (id: number | undefined) => useReturnCheckPayments(id),
  };
});

function check(over: Partial<ReturnCheckRow> = {}): ReturnCheckRow {
  return {
    id: 5, bounced_on: "2026-10-02", customer_name: "Ana Ruiz",
    company_name: "Ruiz Foods", check_number: "1042", payer_bank: "Chase",
    amount: 500, return_check_fee: 25, status: "pending",
    status_changed_on: "", notes: "", recovered_total: 100, payment_count: 1,
    ...over,
  };
}

const payment = {
  id: 11, return_check_id: 5, amount: 100, paid_on: "2026-10-03",
  method: "cash", notes: "at counter",
};

function setEdit(over: Partial<ReturnCheckRow> = {}) {
  useReturnCheck.mockReturnValue({
    data: { return_check: check(over) }, isLoading: false, refetch,
  });
  useReturnCheckPayments.mockReturnValue({
    data: { payments: [payment] }, isLoading: false,
  });
}

function renderForm(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/return-checks/new" element={<ReturnCheckForm />} />
            <Route path="/return-checks/:id/edit" element={<ReturnCheckForm />} />
            <Route path="/return-checks" element={<div>checks list</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function pillStyle(tone: PillTone) {
  const { unmount, container } = render(<Pill tone={tone} dot>x</Pill>);
  const css = container.firstElementChild!.getAttribute("style");
  unmount();
  return css;
}

beforeEach(() => {
  for (const f of [
    createReturnCheck, updateReturnCheck, markLoss, markFraud,
    reopenReturnCheck, createReturnCheckPayment, deleteReturnCheckPayment,
    useReturnCheck, useReturnCheckPayments, refetch,
  ]) {
    f.mockReset();
  }
  useReturnCheck.mockReturnValue({ data: undefined, isLoading: false, refetch });
  useReturnCheckPayments.mockReturnValue({ data: undefined, isLoading: false });
  refetch.mockResolvedValue({});
});

describe("ReturnCheckForm create", () => {
  it("keeps Create disabled until customer and company are filled", async () => {
    renderForm("/return-checks/new");
    const submit = screen.getByRole("button", { name: "Create return check" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Customer name"), "Ana");
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Company name"), "Ruiz Foods");
    expect(submit).toBeEnabled();
  });

  it("sends numeric amounts and the bounce date", async () => {
    createReturnCheck.mockResolvedValue({});
    renderForm("/return-checks/new");
    await userEvent.type(screen.getByLabelText("Customer name"), "Ana Ruiz");
    await userEvent.type(screen.getByLabelText("Company name"), "Ruiz Foods");
    await userEvent.type(screen.getByLabelText("Check number"), "1042");
    await userEvent.type(screen.getByLabelText(/^Amount/), "500.25");
    await userEvent.type(screen.getByLabelText(/^Return check fee/), "25");
    await userEvent.click(screen.getByRole("button", { name: "Create return check" }));

    await waitFor(() => expect(createReturnCheck).toHaveBeenCalledTimes(1));
    expect(createReturnCheck).toHaveBeenCalledWith({
      bounced_on: todayIso(),
      customer_name: "Ana Ruiz",
      company_name: "Ruiz Foods",
      check_number: "1042",
      payer_bank: "",
      amount: 500.25,
      return_check_fee: 25,
      notes: "",
    });
    expect(await screen.findByText("checks list")).toBeInTheDocument();
    expect(screen.getByText("Return check recorded.")).toBeInTheDocument();
  });

  it("shows the server error and stays put when create fails", async () => {
    createReturnCheck.mockRejectedValue(
      new ApiError(422, "Amount must be positive.", { detail: { field: "amount" } }),
    );
    renderForm("/return-checks/new");
    await userEvent.type(screen.getByLabelText("Customer name"), "Ana");
    await userEvent.type(screen.getByLabelText("Company name"), "Ruiz Foods");
    await userEvent.click(screen.getByRole("button", { name: "Create return check" }));
    expect(await screen.findByText("Amount must be positive.")).toBeInTheDocument();
    expect(screen.queryByText("checks list")).not.toBeInTheDocument();
  });

  it("confirms before discarding a dirty form on Cancel", async () => {
    renderForm("/return-checks/new");
    await userEvent.type(screen.getByLabelText("Customer name"), "Ana");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/unsaved edits on this return check/)).toBeInTheDocument();
    expect(screen.queryByText("checks list")).not.toBeInTheDocument();
  });

  it("has no status bar or payments on a new check", () => {
    renderForm("/return-checks/new");
    expect(screen.queryByText("Recovery payments")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark loss" })).not.toBeInTheDocument();
  });
});

describe("ReturnCheckForm edit", () => {
  it("hydrates the form and PUTs the changed values", async () => {
    setEdit();
    updateReturnCheck.mockResolvedValue({});
    renderForm("/return-checks/5/edit");
    expect(screen.getByLabelText("Customer name")).toHaveValue("Ana Ruiz");
    await userEvent.clear(screen.getByLabelText("Payer bank"));
    await userEvent.type(screen.getByLabelText("Payer bank"), "Wells Fargo");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateReturnCheck).toHaveBeenCalledTimes(1));
    expect(updateReturnCheck).toHaveBeenCalledWith(5, {
      bounced_on: "2026-10-02",
      customer_name: "Ana Ruiz",
      company_name: "Ruiz Foods",
      check_number: "1042",
      payer_bank: "Wells Fargo",
      amount: 500,
      return_check_fee: 25,
      notes: "",
    });
    expect(await screen.findByText("Return check updated.")).toBeInTheDocument();
  });

  it("shows recovered-of-total (face amount plus fee) with the status tone", () => {
    setEdit();
    renderForm("/return-checks/5/edit");
    const bar = screen.getByText(/Recovered/).parentElement!;
    expect(bar).toHaveTextContent("Recovered $100.00 of $525.00");
    const pill = screen.getByText("Pending");
    expect(pill.getAttribute("style"))
      .toBe(pillStyle(RETURN_CHECK_STATUS_TONES.pending));
  });

  it.each([["loss"], ["fraud"]])(
    "paints %s with the negative tone and offers Reopen instead of write-offs",
    (status) => {
      setEdit({ status });
      renderForm("/return-checks/5/edit");
      const label = status.charAt(0).toUpperCase() + status.slice(1);
      expect(screen.getByText(label).getAttribute("style"))
        .toBe(pillStyle(RETURN_CHECK_STATUS_TONES[status]));
      expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Mark loss" })).not.toBeInTheDocument();
      // A closed check takes no payments and its payments cannot be removed.
      expect(screen.queryByRole("button", { name: "Record payment" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    },
  );

  it("has no Reopen on a recovered check", () => {
    setEdit({ status: "recovered", recovered_total: 525 });
    renderForm("/return-checks/5/edit");
    expect(screen.queryByRole("button", { name: "Reopen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark loss" })).not.toBeInTheDocument();
  });
});

describe("ReturnCheckForm status transitions", () => {
  it.each([
    ["Mark loss", () => markLoss],
    ["Mark fraud", () => markFraud],
  ])("%s asks first, then calls the API and refetches", async (label, fn) => {
    setEdit();
    fn().mockResolvedValue({});
    renderForm("/return-checks/5/edit");
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(fn()).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(`${label} this return check?`)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: label }));
    await waitFor(() => expect(fn()).toHaveBeenCalledWith(5));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it("cancelling the confirm does nothing", async () => {
    setEdit();
    renderForm("/return-checks/5/edit");
    await userEvent.click(screen.getByRole("button", { name: "Mark loss" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(markLoss).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Reopen confirms with a non-destructive prompt, then calls the API", async () => {
    setEdit({ status: "loss" });
    reopenReturnCheck.mockResolvedValue({});
    renderForm("/return-checks/5/edit");
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Re-opens this check for collection/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(reopenReturnCheck).toHaveBeenCalledWith(5));
  });

  it("surfaces a server refusal instead of closing silently", async () => {
    setEdit();
    markFraud.mockRejectedValue(new ApiError(409, "Check already has payments.", null));
    renderForm("/return-checks/5/edit");
    await userEvent.click(screen.getByRole("button", { name: "Mark fraud" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark fraud" }));
    // The open dialog hides the page behind it from the a11y tree.
    expect(await screen.findByText("Check already has payments.", {}, { timeout: 2000 }))
      .toBeInTheDocument();
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe("ReturnCheckForm recovery payments", () => {
  it("lists payments and records one with a numeric amount", async () => {
    setEdit();
    createReturnCheckPayment.mockResolvedValue({});
    renderForm("/return-checks/5/edit");
    const row = screen.getByText("at counter").closest("tr")!;
    expect(row).toHaveTextContent("$100.00");
    expect(row).toHaveTextContent("2026-10-03");

    // $525 owed - $100 recovered.
    expect(screen.getByText("Up to $425.00 remaining.")).toBeInTheDocument();
    const record = screen.getByRole("button", { name: "Record payment" });
    expect(record).toBeDisabled();
    const form = record.closest("form")!;
    await userEvent.type(within(form).getByLabelText(/^Amount/), "150.75");
    await userEvent.selectOptions(within(form).getByLabelText("Method"), "zelle");
    await userEvent.type(within(form).getByLabelText("Note (optional)"), "from Ana");
    await userEvent.click(record);

    await waitFor(() => expect(createReturnCheckPayment).toHaveBeenCalledTimes(1));
    expect(createReturnCheckPayment).toHaveBeenCalledWith(5, {
      paid_on: todayIso(), amount: 150.75, method: "zelle", note: "from Ana",
    });
  });

  it("shows the server's message when recording fails", async () => {
    setEdit();
    createReturnCheckPayment.mockRejectedValue(
      new ApiError(400, "Payment exceeds the remaining balance.", null),
    );
    renderForm("/return-checks/5/edit");
    const form = screen.getByRole("button", { name: "Record payment" }).closest("form")!;
    await userEvent.type(within(form).getByLabelText(/^Amount/), "9999");
    await userEvent.click(screen.getByRole("button", { name: "Record payment" }));
    expect(await screen.findByText("Payment exceeds the remaining balance."))
      .toBeInTheDocument();
  });

  it("asks before removing a payment, then deletes that payment", async () => {
    setEdit();
    deleteReturnCheckPayment.mockResolvedValue({});
    renderForm("/return-checks/5/edit");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(deleteReturnCheckPayment).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Remove the $100.00 payment from 2026-10-03?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deleteReturnCheckPayment).toHaveBeenCalledWith(5, 11));
  });

  it("shows the server's message when removal fails", async () => {
    setEdit();
    deleteReturnCheckPayment.mockRejectedValue(new ApiError(409, "Day is locked.", null));
    renderForm("/return-checks/5/edit");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Day is locked.", {}, { timeout: 2000 }))
      .toBeInTheDocument();
  });

  it("hides Remove without return_checks.delete (the API refuses it)", () => {
    setCurrentIdentity({
      ...TEST_ADMIN,
      permissions: TEST_ADMIN.permissions.filter((p) => p !== "return_checks.delete"),
    });
    setEdit();
    renderForm("/return-checks/5/edit");
    expect(screen.getByText("at counter")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
});
