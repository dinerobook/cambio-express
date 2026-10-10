import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import OwnerBilling from "./OwnerBilling";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import type { OwnerBillingResponse, OwnerBillingRow } from "../api/owner";

// Owner billing rollup (B-1). Pinned: totals add plans + add-ons,
// attention slugs map to the right wording, Manage / Subscribe
// switch into the store and land on the page that can act, only an
// owner (not a superadmin) gets the switch button, and a refused
// switch is toasted.

const switchStore = vi.fn();
const refetch = vi.fn();
let state: { data?: OwnerBillingResponse; isLoading: boolean; isError: boolean; error?: unknown };

vi.mock("../api/owner", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/owner")>();
  return { ...real, useOwnerBilling: () => ({ ...state, refetch }) };
});
vi.mock("../api/switchStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/switchStore")>();
  return { ...real, switchStore: (id: number) => switchStore(id) };
});

function row(id: number, name: string, over: Partial<OwnerBillingRow> = {}): OwnerBillingRow {
  return {
    store_id: id, store_name: name, store_slug: name.toLowerCase(),
    addon_count: 0, addon_monthly_cost: 0, attention: "", billing_cycle: "monthly",
    has_paid_plan: true, monthly_cost: 49, plan: "pro", plan_label: "Pro",
    plan_price_label: "$49/mo", retention_days_left: null, trial_days_left: null,
    trial_ends_at: null, trial_status: "exempt", ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/owner/billing"]}>
          <Routes>
            <Route path="/owner/billing" element={<OwnerBilling />} />
            <Route path="/admin/subscription" element={<p>subscription page</p>} />
            <Route path="/subscribe" element={<p>plan picker</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const rowOf = (name: string) => screen.getByText(name).closest("tr")!;

describe("OwnerBilling", () => {
  beforeEach(() => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "owner", store_id: null });
    switchStore.mockReset();
    switchStore.mockResolvedValue(undefined);
    refetch.mockReset();
    state = {
      data: {
        rows: [
          row(1, "North", { addon_count: 1, addon_monthly_cost: 10 }),
          row(2, "South", {
            has_paid_plan: false, plan: "trial", plan_label: "Trial", monthly_cost: 0,
            attention: "trial_ending", trial_days_left: 2,
          }),
          row(3, "East", {
            has_paid_plan: false, plan: "inactive", plan_label: "Inactive", monthly_cost: 0,
            attention: "retention", retention_days_left: 0,
          }),
        ],
        totals: {
          monthly_cost: 49, addon_monthly_cost: 10, attention_count: 2,
          inactive_stores: 1, paid_stores: 1, stores: 3, trial_stores: 1,
        },
      },
      isLoading: false, isError: false,
    };
  });

  it("is closed to a store admin", () => {
    setCurrentIdentity(TEST_ADMIN);
    renderPage();
    expect(screen.getByText(/Sign in as an owner/)).toBeInTheDocument();
  });

  it("adds plans and add-ons into the monthly total", () => {
    renderPage();
    const total = screen.getByText("Monthly total").parentElement!;
    expect(total).toHaveTextContent("$59.00");
    expect(total).toHaveTextContent("$49.00 plans + $10.00 add-ons");
    expect(screen.getByText("Needs attention").parentElement).toHaveTextContent("2");
  });

  it("words each store's status from its attention slug", () => {
    renderPage();
    expect(within(rowOf("North")).getByText("Active")).toBeInTheDocument();
    expect(rowOf("North")).toHaveTextContent("1 · $10.00");
    expect(within(rowOf("South")).getByText("Trial ending")).toBeInTheDocument();
    expect(rowOf("South")).toHaveTextContent("2 days left");
    expect(within(rowOf("East")).getByText("Purging soon")).toBeInTheDocument();
    expect(rowOf("East")).toHaveTextContent("Data purges today");
  });

  it("Manage switches into a paid store and lands on its subscription", async () => {
    renderPage();
    await userEvent.click(within(rowOf("North")).getByRole("button", { name: "Manage" }));
    expect(await screen.findByText("subscription page")).toBeInTheDocument();
    expect(switchStore).toHaveBeenCalledWith(1);
  });

  it("Subscribe switches into an unpaid store and lands on the plan picker", async () => {
    renderPage();
    await userEvent.click(within(rowOf("South")).getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByText("plan picker")).toBeInTheDocument();
    expect(switchStore).toHaveBeenCalledWith(2);
  });

  it("toasts a refused switch and stays on the page", async () => {
    switchStore.mockRejectedValue(new ApiError(403, "Not your store.", null));
    renderPage();
    await userEvent.click(within(rowOf("North")).getByRole("button", { name: "Manage" }));
    expect(await screen.findByText("Not your store.")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(rowOf("North")).getByRole("button", { name: "Manage" })).toBeEnabled());
  });

  it("gives a superadmin the rollup without the switch buttons", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "superadmin", store_id: null });
    renderPage();
    expect(screen.getByText("North")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage" })).not.toBeInTheDocument();
  });

  it("shows ErrorState with a working Retry", async () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "Billing is down", null) };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Billing is down");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});
