import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminStores from "./SuperadminStores";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import type { SuperadminStoreRow } from "../api/superadmin";

// The platform-wide store list. Pinned: superadmin-only, client
// search over name / slug / email, ErrorState with retry, and the
// bulk action sends exactly the selected store ids.

const bulkStoreAction = vi.fn();
const refetch = vi.fn();
let state: {
  data?: { rows: SuperadminStoreRow[]; total: number };
  isLoading: boolean; isError: boolean; error?: unknown;
};

vi.mock("../api/superadmin", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/superadmin")>();
  return {
    ...real,
    useSuperadminStores: () => ({ ...state, refetch }),
    bulkStoreAction: (...a: unknown[]) => bulkStoreAction(...a),
  };
});

function store(id: number, name: string, over: Partial<SuperadminStoreRow> = {}): SuperadminStoreRow {
  return {
    store_id: id, name, slug: name.toLowerCase(), email: `${name.toLowerCase()}@x.com`,
    phone: "", plan: "pro", billing_cycle: "monthly", is_active: true,
    created_at: "2026-01-01T00:00:00", trial_ends_at: "", grace_ends_at: "",
    data_retention_until: "", stripe_customer_id: "", stripe_subscription_id: "",
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <SuperadminStores />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("SuperadminStores", () => {
  beforeEach(() => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "superadmin", store_id: null });
    bulkStoreAction.mockReset();
    bulkStoreAction.mockResolvedValue({ count: 2 });
    refetch.mockReset();
    state = {
      data: {
        rows: [
          store(1, "Alpha", { plan: "trial", trial_ends_at: "2026-11-01T00:00:00" }),
          store(2, "Bravo", { is_active: false, data_retention_until: "2027-03-01T00:00:00" }),
          store(3, "Charlie"),
        ],
        total: 3,
      },
      isLoading: false, isError: false,
    };
  });

  it("refuses anyone but a superadmin", () => {
    setCurrentIdentity(TEST_ADMIN);
    renderPage();
    expect(screen.getByText("Superadmin scope required.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("lists stores with plan, status and trial / retention", () => {
    renderPage();
    const alpha = screen.getByText("Alpha").closest("tr")!;
    expect(alpha).toHaveTextContent("Trial");
    expect(alpha).toHaveTextContent("Trial ends");
    const bravo = screen.getByText("Bravo").closest("tr")!;
    expect(within(bravo).getByText("Inactive")).toBeInTheDocument();
    expect(bravo).toHaveTextContent("Purge");
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
  });

  it("filters by name, slug or email as you type", async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/Search name/), "brav");
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    await userEvent.clear(screen.getByPlaceholderText(/Search name/));
    await userEvent.type(screen.getByPlaceholderText(/Search name/), "zzz");
    expect(screen.getByText("No stores match these filters.")).toBeInTheDocument();
  });

  it("shows ErrorState with a working Retry", async () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "Stores are down", null) };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Stores are down");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("applies a bulk action to exactly the selected stores", async () => {
    renderPage();
    await userEvent.click(screen.getByLabelText("Select Alpha"));
    await userEvent.click(screen.getByLabelText("Select Charlie"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    await userEvent.selectOptions(screen.getByDisplayValue("— Choose action —"), "extend_trial");
    await userEvent.click(apply);
    await waitFor(() => expect(bulkStoreAction).toHaveBeenCalledWith([1, 3], "extend_trial"));
    expect(await screen.findByText("2 stores updated.")).toBeInTheDocument();
    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();
  });

  it("keeps the selection and shows the refusal when a bulk action fails", async () => {
    bulkStoreAction.mockRejectedValue(new ApiError(400, "Cannot disable a paid store.", null));
    renderPage();
    await userEvent.click(screen.getByLabelText("Select all stores"));
    await userEvent.selectOptions(screen.getByDisplayValue("— Choose action —"), "disable");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(bulkStoreAction).toHaveBeenCalledWith([1, 2, 3], "disable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot disable a paid store.");
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  // Selection follows the search: a hidden store is never counted or acted on.
  it("does not show 'select all' as checked when only a hidden store is selected", async () => {
    renderPage();
    await userEvent.click(screen.getByLabelText("Select Alpha"));
    await userEvent.type(screen.getByPlaceholderText(/Search name/), "charlie");
    expect(screen.getByLabelText("Select Charlie")).not.toBeChecked();
    expect(screen.getByLabelText("Select all stores")).not.toBeChecked();
  });

  it("applies a bulk action only to the stores the search shows", async () => {
    renderPage();
    await userEvent.click(screen.getByLabelText("Select Alpha"));
    await userEvent.type(screen.getByPlaceholderText(/Search name/), "charlie");
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Select all stores"));
    expect(screen.getByLabelText("Select Charlie")).toBeChecked();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByDisplayValue("— Choose action —"), "enable");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(bulkStoreAction).toHaveBeenCalledWith([3], "enable"));
  });
});
