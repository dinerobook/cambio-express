import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Subscribe from "./Subscribe";

// The plan picker reads the store's subscription summary once. It
// used to refetch in a loop (an effect keyed on a fresh identity
// object every render), and every fetch is a Stripe round-trip on
// the server.

const fetchSubscriptionSummary = vi.fn();

vi.mock("../api/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/billing")>();
  return {
    ...real,
    fetchSubscriptionSummary: () => fetchSubscriptionSummary(),
  };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Subscribe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const PAID = {
  store: { plan: "pro" },
  has_paid_plan: true,
  cancel_at_period_end: false,
  cancel_at: null,
  plan_label: "Pro",
  plan_price: "$45 / month",
};

beforeEach(() => {
  fetchSubscriptionSummary.mockReset();
});

describe("Subscribe", () => {
  it("fetches the summary once, not in a loop", async () => {
    fetchSubscriptionSummary.mockResolvedValue(PAID);
    renderPage();
    expect(await screen.findByText("Choose a plan")).toBeInTheDocument();
    expect(await screen.findAllByText("Current plan")).not.toHaveLength(0);
    // Give a looping effect time to fire again.
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchSubscriptionSummary).toHaveBeenCalledTimes(1);
  });

  it("still offers every plan when the summary fails", async () => {
    fetchSubscriptionSummary.mockRejectedValue(new Error("down"));
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Subscribe" })).toHaveLength(4));
    expect(fetchSubscriptionSummary).toHaveBeenCalledTimes(1);
  });
});
