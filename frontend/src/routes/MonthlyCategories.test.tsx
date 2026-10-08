import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MonthlyCategories from "./MonthlyCategories";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// P&L categories: the store names its own lines. Pinned here:
//   - Each line shows the store's current name (or empty = default).
//   - A free slot is flagged, and naming it flips it to "In use".
//   - Save sends ONLY the lines that changed, and an emptied custom
//     name goes as "" (the server's "reset to default").
//   - Nothing changed -> Save is off; a refusal shows the reason.

const updateMonthlyLabels = vi.fn();
const useMonthlyLabels = vi.fn();

vi.mock("../api/monthly", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/monthly")>();
  return {
    ...real,
    updateMonthlyLabels: (...a: unknown[]) => updateMonthlyLabels(...a),
    useMonthlyLabels: (...a: unknown[]) => useMonthlyLabels(...a),
  };
});

const line = (over: Record<string, unknown>) => ({
  label: "", default_label: "", is_custom: false, section: "Income",
  is_slot: false, bank_taggable: true, field: "", ...over,
});

// Stable identity: the draft re-hydrates when `data` changes.
const data = {
  lines: [
    line({
      field: "boost_mobile", default_label: "Boost Mobile",
      label: "Top-ups", is_custom: true,
    }),
    line({
      field: "non_taxable", default_label: "Non-taxable",
      label: "Non-taxable", bank_taggable: false,
    }),
    line({
      field: "other_income_1", default_label: "Other income 1",
      label: "Other income 1", is_slot: true,
    }),
    line({
      field: "other_expense_1", default_label: "Other expense 1",
      label: "Other expense 1", is_slot: true, section: "Expenses",
    }),
  ],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <MonthlyCategories />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("MonthlyCategories", () => {
  beforeEach(() => {
    updateMonthlyLabels.mockReset();
    updateMonthlyLabels.mockResolvedValue(data);
    useMonthlyLabels.mockReset();
    useMonthlyLabels.mockReturnValue({
      data, isLoading: false, isFetching: false, isError: false, refetch: vi.fn(),
    });
  });

  it("shows the store's custom name and leaves defaults empty", () => {
    renderPage();
    expect(screen.getByLabelText("Name for Boost Mobile")).toHaveValue("Top-ups");
    expect(screen.getByLabelText("Name for Non-taxable")).toHaveValue("");
    expect(screen.getByLabelText("Name for Other income 1")).toHaveValue("");
  });

  it("flags blank slots and explains lines the bank cannot tag", () => {
    renderPage();
    expect(screen.getAllByText("Free slot")).toHaveLength(2);
    expect(screen.getByText(/The register feeds this line/)).toBeInTheDocument();
  });

  it("keeps Save off until something changes", async () => {
    renderPage();
    const save = screen.getByRole("button", { name: "Save names" });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Name for Other expense 1"), "Bank Fee");
    expect(save).toBeEnabled();
  });

  it("marks a slot In use once it is named", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText("Name for Other expense 1"), "Bank Fee");
    expect(screen.getAllByText("Free slot")).toHaveLength(1);
    expect(screen.getByText("In use")).toBeInTheDocument();
  });

  it("sends only the lines that changed", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText("Name for Other expense 1"), "Bank Fee");
    await userEvent.click(screen.getByRole("button", { name: "Save names" }));
    await waitFor(() => expect(updateMonthlyLabels).toHaveBeenCalledTimes(1));
    expect(updateMonthlyLabels).toHaveBeenCalledWith({ other_expense_1: "Bank Fee" });
    expect(await screen.findByText("Category names saved.")).toBeInTheDocument();
    // Saved -> the draft is the new baseline.
    expect(screen.getByRole("button", { name: "Save names" })).toBeDisabled();
  });

  it("resets a custom name to the default by sending an empty string", async () => {
    renderPage();
    await userEvent.clear(screen.getByLabelText("Name for Boost Mobile"));
    await userEvent.click(screen.getByRole("button", { name: "Save names" }));
    await waitFor(() => expect(updateMonthlyLabels).toHaveBeenCalled());
    expect(updateMonthlyLabels).toHaveBeenCalledWith({ boost_mobile: "" });
  });

  it("shows the server's reason when a name is refused", async () => {
    updateMonthlyLabels.mockRejectedValue(
      new ApiError(422, "That name is already used.", null),
    );
    renderPage();
    await userEvent.type(screen.getByLabelText("Name for Other income 1"), "Top-ups");
    await userEvent.click(screen.getByRole("button", { name: "Save names" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That name is already used.");
    expect(screen.queryByText("Category names saved.")).not.toBeInTheDocument();
    // Still dirty, so the operator can fix it and retry.
    expect(screen.getByRole("button", { name: "Save names" })).toBeEnabled();
  });

  it("shows a retryable error when the names fail to load", async () => {
    const refetch = vi.fn();
    useMonthlyLabels.mockReturnValue({
      data: undefined, isLoading: false, isFetching: false, isError: true,
      error: new Error("Names unavailable"), refetch,
    });
    renderPage();
    expect(screen.getByText("Names unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save names" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("offers no form without a store", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "superadmin", store_id: null });
    renderPage();
    expect(screen.getByText(/Sign in as a store admin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save names" })).not.toBeInTheDocument();
  });
});
