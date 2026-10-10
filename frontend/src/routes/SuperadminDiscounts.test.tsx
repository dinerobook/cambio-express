import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminDiscounts from "./SuperadminDiscounts";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import type { DiscountCodeRow } from "../api/featureFlags";

// Superadmin discount codes: list + enable / disable toggle. The
// toggle sends the OPPOSITE of the row's current state.

const toggleDiscount = vi.fn();
const refetch = vi.fn();
let state: {
  data?: { rows: DiscountCodeRow[]; total: number };
  isLoading: boolean; isError: boolean; error?: unknown;
};

vi.mock("../api/featureFlags", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/featureFlags")>();
  return {
    ...real,
    useDiscounts: () => ({ ...state, refetch }),
    toggleDiscount: (...a: unknown[]) => toggleDiscount(...a),
  };
});

function row(id: number, code: string, over: Partial<DiscountCodeRow> = {}): DiscountCodeRow {
  return {
    id, code, label: code, percent_off: 20, amount_off_cents: null,
    value_label: "20% off", duration: "repeating", duration_in_months: 3,
    max_redemptions: 10, redeemed_count: 4, expires_at: "2026-12-31T00:00:00",
    is_active: true, is_redeemable: true, ...over,
  } as DiscountCodeRow;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <SuperadminDiscounts />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("SuperadminDiscounts", () => {
  beforeEach(() => {
    toggleDiscount.mockReset();
    toggleDiscount.mockResolvedValue({});
    state = {
      data: {
        rows: [
          row(1, "SPRING20"),
          row(2, "OLDCODE", { is_active: false, is_redeemable: false, max_redemptions: null }),
        ],
        total: 2,
      },
      isLoading: false, isError: false,
    };
  });

  it("lists the codes with their status", () => {
    renderPage();
    const spring = screen.getByText("SPRING20").closest("tr")!;
    expect(spring).toHaveTextContent("20% off");
    expect(spring).toHaveTextContent("3 mo");
    expect(spring).toHaveTextContent("4 / 10");
    expect(within(spring).getByText("Redeemable")).toBeInTheDocument();
    const old = screen.getByText("OLDCODE").closest("tr")!;
    expect(within(old).getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText(/2 codes total/)).toBeInTheDocument();
  });

  it("shows the empty state when Stripe has no codes", () => {
    state = { data: { rows: [], total: 0 }, isLoading: false, isError: false };
    renderPage();
    expect(screen.getByText("No discount codes")).toBeInTheDocument();
  });

  it("disables an active code and confirms with a toast", async () => {
    renderPage();
    const spring = screen.getByText("SPRING20").closest("tr")!;
    await userEvent.click(within(spring).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(toggleDiscount).toHaveBeenCalledWith(1, false));
    expect(await screen.findByText("SPRING20 → disabled")).toBeInTheDocument();
  });

  it("enables a disabled code", async () => {
    renderPage();
    const old = screen.getByText("OLDCODE").closest("tr")!;
    await userEvent.click(within(old).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(toggleDiscount).toHaveBeenCalledWith(2, true));
  });

  it("toasts the server's refusal", async () => {
    toggleDiscount.mockRejectedValue(new ApiError(502, "Stripe is unavailable.", null));
    renderPage();
    const spring = screen.getByText("SPRING20").closest("tr")!;
    await userEvent.click(within(spring).getByRole("button", { name: "Disable" }));
    expect(await screen.findByText("Stripe is unavailable.")).toBeInTheDocument();
  });

  it("shows an error when the list fails to load", () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "x", null) };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load discount codes.");
  });

  it("offers Retry when the list fails to load", async () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "x", null) };
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});
